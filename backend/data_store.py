from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import json
import math
import os
from typing import Any, Protocol
from urllib import error, request


SCORE_PILE_WEIGHT = 1.0
SCORE_SIZE_WEIGHT = 0.7
GREEN_THRESHOLD = 15.0
YELLOW_THRESHOLD = 35.0

DEFAULT_RADIUS_KM = 2.0
MAX_RADIUS_KM = 20.0

# In-memory fallback ZIP centroids for local development/tests.
ZIP_CENTROIDS = {
    "92801": (33.8446, -117.9539),
    "92802": (33.8098, -117.9190),
    "92804": (33.8188, -117.9736),
    "10001": (40.7506, -73.9972),
    "94103": (37.7725, -122.4091),
}


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def score_to_color(score: float) -> str:
    if score < GREEN_THRESHOLD:
        return "green"
    if score < YELLOW_THRESHOLD:
        return "yellow"
    return "red"


def compute_score(pile_count: int, total_size: int) -> float:
    return round((pile_count * SCORE_PILE_WEIGHT) + (total_size * SCORE_SIZE_WEIGHT), 2)


def _haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    r = 6371
    lat1, lng1, lat2, lng2 = map(math.radians, [lat1, lng1, lat2, lng2])
    dlat = lat2 - lat1
    dlng = lng2 - lng1
    a = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlng / 2) ** 2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return r * c


@dataclass
class DroneRound:
    id: str
    started_at: datetime
    ended_at: datetime | None
    status: str


@dataclass
class DronePosition:
    round_id: str
    drone_id: str
    recorded_at: datetime
    lat: float
    lng: float


@dataclass
class TrashEntry:
    id: str
    round_id: str
    drone_id: str
    detected_at: datetime
    lat: float
    lng: float
    size: int
    meta: dict[str, Any]


class DataStore(Protocol):
    def start_new_round(self, round_id: str | None = None) -> DroneRound:
        ...

    def upsert_drone_position(
        self,
        round_id: str,
        drone_id: str,
        lat: float,
        lng: float,
        recorded_at: datetime | None = None,
    ) -> DronePosition:
        ...

    def insert_trash_entry(
        self,
        round_id: str,
        drone_id: str,
        lat: float,
        lng: float,
        size: int,
        detected_at: datetime | None = None,
        meta: dict[str, Any] | None = None,
    ) -> TrashEntry:
        ...

    def get_hotspots_by_zip(self, zip_code: str, radius_km: float) -> list[dict[str, Any]]:
        ...


class InMemoryDataStore:
    def __init__(self):
        self.rounds: list[DroneRound] = []
        self.drone_positions_current: dict[str, DronePosition] = {}
        self.trash_entries: list[TrashEntry] = []

    def reset(self):
        self.rounds = []
        self.drone_positions_current = {}
        self.trash_entries = []

    def start_new_round(self, round_id: str | None = None) -> DroneRound:
        if self.rounds and self.rounds[-1].status == "active":
            self.rounds[-1].status = "completed"
            self.rounds[-1].ended_at = utc_now()
        self.drone_positions_current = {}
        round_model = DroneRound(
            id=round_id or f"round_{int(utc_now().timestamp())}",
            started_at=utc_now(),
            ended_at=None,
            status="active",
        )
        self.rounds.append(round_model)
        return round_model

    def upsert_drone_position(
        self,
        round_id: str,
        drone_id: str,
        lat: float,
        lng: float,
        recorded_at: datetime | None = None,
    ) -> DronePosition:
        position = DronePosition(
            round_id=round_id,
            drone_id=drone_id,
            lat=lat,
            lng=lng,
            recorded_at=recorded_at or utc_now(),
        )
        self.drone_positions_current[drone_id] = position
        return position

    def insert_trash_entry(
        self,
        round_id: str,
        drone_id: str,
        lat: float,
        lng: float,
        size: int,
        detected_at: datetime | None = None,
        meta: dict[str, Any] | None = None,
    ) -> TrashEntry:
        if size < 1 or size > 10:
            raise ValueError("size must be between 1 and 10")
        entry = TrashEntry(
            id=f"trash_{len(self.trash_entries) + 1}",
            round_id=round_id,
            drone_id=drone_id,
            detected_at=detected_at or utc_now(),
            lat=lat,
            lng=lng,
            size=size,
            meta=meta or {},
        )
        self.trash_entries.append(entry)
        return entry

    def get_hotspots_by_zip(self, zip_code: str, radius_km: float) -> list[dict[str, Any]]:
        centroid = ZIP_CENTROIDS.get(zip_code)
        if centroid is None:
            raise KeyError("zip_not_found")

        center_lat, center_lng = centroid
        entries_in_radius = [
            entry
            for entry in self.trash_entries
            if _haversine_km(center_lat, center_lng, entry.lat, entry.lng) <= radius_km
        ]
        if not entries_in_radius:
            return []

        # Lightweight clustering by ~120m grid buckets.
        clusters: dict[tuple[float, float], list[TrashEntry]] = {}
        for entry in entries_in_radius:
            key = (round(entry.lat, 3), round(entry.lng, 3))
            clusters.setdefault(key, []).append(entry)

        results: list[dict[str, Any]] = []
        for idx, (_, cluster_entries) in enumerate(clusters.items(), start=1):
            pile_count = len(cluster_entries)
            total_size = sum(entry.size for entry in cluster_entries)
            avg_size = round(total_size / pile_count, 2)
            score = compute_score(pile_count, total_size)
            lat = round(sum(e.lat for e in cluster_entries) / pile_count, 6)
            lng = round(sum(e.lng for e in cluster_entries) / pile_count, 6)
            latest_at = max(entry.detected_at for entry in cluster_entries)
            results.append(
                {
                    "hotspot_id": f"cluster_{idx}",
                    "lat": lat,
                    "lng": lng,
                    "pile_count": pile_count,
                    "avg_size": avg_size,
                    "total_size": total_size,
                    "score": score,
                    "color": score_to_color(score),
                    "last_detected_at": latest_at.isoformat(),
                    "photo_url": next(
                        (
                            str(entry.meta.get("photo_url"))
                            for entry in sorted(
                                cluster_entries,
                                key=lambda e: e.detected_at,
                                reverse=True,
                            )
                            if entry.meta.get("photo_url")
                        ),
                        None,
                    ),
                }
            )
        results.sort(key=lambda item: item["score"], reverse=True)
        return results


class SupabaseDataStore:
    def __init__(self, base_url: str, service_role_key: str):
        self.base_url = base_url.rstrip("/")
        self.service_role_key = service_role_key

    def _rpc(self, function_name: str, payload: dict[str, Any]) -> Any:
        url = f"{self.base_url}/rest/v1/rpc/{function_name}"
        headers = {
            "apikey": self.service_role_key,
            "Authorization": f"Bearer {self.service_role_key}",
            "Content-Type": "application/json",
        }
        body = json.dumps(payload).encode("utf-8")
        req = request.Request(url, data=body, headers=headers, method="POST")
        try:
            with request.urlopen(req, timeout=30) as response:
                data = response.read().decode("utf-8")
                return json.loads(data) if data else None
        except error.HTTPError as exc:
            detail = exc.read().decode("utf-8")
            raise RuntimeError(f"Supabase RPC {function_name} failed: {detail}") from exc

    def start_new_round(self, round_id: str | None = None) -> DroneRound:
        payload = self._rpc("start_new_round", {"drone_round_id": round_id})
        return DroneRound(
            id=payload["id"],
            started_at=datetime.fromisoformat(payload["started_at"]),
            ended_at=datetime.fromisoformat(payload["ended_at"]) if payload.get("ended_at") else None,
            status=payload["status"],
        )

    def upsert_drone_position(
        self,
        round_id: str,
        drone_id: str,
        lat: float,
        lng: float,
        recorded_at: datetime | None = None,
    ) -> DronePosition:
        payload = self._rpc(
            "upsert_drone_position",
            {
                "in_round_id": round_id,
                "in_drone_id": drone_id,
                "in_recorded_at": (recorded_at or utc_now()).isoformat(),
                "in_lat": lat,
                "in_lng": lng,
            },
        )
        return DronePosition(
            round_id=payload["round_id"],
            drone_id=payload["drone_id"],
            recorded_at=datetime.fromisoformat(payload["recorded_at"]),
            lat=payload["lat"],
            lng=payload["lng"],
        )

    def insert_trash_entry(
        self,
        round_id: str,
        drone_id: str,
        lat: float,
        lng: float,
        size: int,
        detected_at: datetime | None = None,
        meta: dict[str, Any] | None = None,
    ) -> TrashEntry:
        payload = self._rpc(
            "insert_trash_entry",
            {
                "in_round_id": round_id,
                "in_drone_id": drone_id,
                "in_detected_at": (detected_at or utc_now()).isoformat(),
                "in_lat": lat,
                "in_lng": lng,
                "in_size": size,
                "in_meta": meta or {},
            },
        )
        return TrashEntry(
            id=payload["id"],
            round_id=payload["round_id"],
            drone_id=payload["drone_id"],
            detected_at=datetime.fromisoformat(payload["detected_at"]),
            lat=payload["lat"],
            lng=payload["lng"],
            size=payload["size"],
            meta=payload.get("meta") or {},
        )

    def get_hotspots_by_zip(self, zip_code: str, radius_km: float) -> list[dict[str, Any]]:
        return self._rpc(
            "get_hotspots_by_zip",
            {"zip_code_in": zip_code, "radius_m_in": int(radius_km * 1000)},
        )


_DATA_STORE: DataStore | None = None


def get_data_store() -> DataStore:
    global _DATA_STORE
    if _DATA_STORE is not None:
        return _DATA_STORE

    base_url = os.getenv("SUPABASE_URL")
    service_role_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    if base_url and service_role_key:
        _DATA_STORE = SupabaseDataStore(base_url, service_role_key)
    else:
        _DATA_STORE = InMemoryDataStore()
    return _DATA_STORE


def reset_data_store_for_tests() -> None:
    global _DATA_STORE
    _DATA_STORE = InMemoryDataStore()
