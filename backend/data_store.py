from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import json
import math
import mimetypes
import os
from pathlib import Path
import re
from typing import Any, Protocol
from urllib import error, request
from urllib.parse import quote
from uuid import uuid4


SCORE_PILE_WEIGHT = 1.0
SCORE_SIZE_WEIGHT = 0.7
GREEN_THRESHOLD = 15.0
YELLOW_THRESHOLD = 35.0

DEFAULT_RADIUS_KM = 2.0
MAX_RADIUS_KM = 20.0
WASTE_KG_PER_SIZE_POINT = 0.2
CLEANUP_MIN_PER_PILE = 4
MIN_CLEANUP_MINUTES = 5

# In-memory fallback ZIP centroids for local development/tests.
ZIP_CENTROIDS = {
    "92801": (33.8446, -117.9539),
    "92802": (33.8098, -117.9190),
    "92804": (33.8188, -117.9736),
    "10001": (40.7506, -73.9972),
    "94103": (37.7725, -122.4091),
}


def _load_zip_centroids_from_seed_sql() -> dict[str, tuple[float, float]]:
    seeds_dir = Path(__file__).resolve().parent / "supabase" / "seeds"
    if not seeds_dir.exists():
        return {}

    rows: dict[str, tuple[float, float]] = {}
    for seed_path in sorted(seeds_dir.glob("seed_*_zip_centroids.sql")):
        content = seed_path.read_text(encoding="utf-8")
        matches = re.findall(r"\('(\d{5})',\s*([-\d.]+),\s*([-\d.]+)\)", content)
        for zip_code, lat, lng in matches:
            rows[zip_code] = (float(lat), float(lng))
    return rows


ZIP_CENTROIDS.update(_load_zip_centroids_from_seed_sql())


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


def compute_estimated_waste_kg(total_size: int) -> float:
    return round(total_size * WASTE_KG_PER_SIZE_POINT, 1)


def compute_cleanup_time_minutes(pile_count: int) -> int:
    return max(MIN_CLEANUP_MINUTES, pile_count * CLEANUP_MIN_PER_PILE)


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


@dataclass
class DisposalSite:
    id: str
    name: str
    lat: float
    lng: float
    site_type: str
    accepted_types: list[str]
    hours: str
    address: str
    maps_url: str
    active: bool = True


DISPOSAL_SITES: list[DisposalSite] = [
    DisposalSite(
        id="site_oc_frank_bowerman_1",
        name="Frank R. Bowerman Landfill",
        lat=33.7185,
        lng=-117.7098,
        site_type="landfill",
        accepted_types=["municipal_solid_waste", "treated_wood"],
        hours="Mon-Sat 7:00 AM - 4:00 PM",
        address="11002 Bee Canyon Access Rd, Irvine, CA 92602",
        maps_url="https://www.google.com/maps/search/?api=1&query=Frank+R.+Bowerman+Landfill+11002+Bee+Canyon+Access+Rd+Irvine+CA+92602",
    ),
    DisposalSite(
        id="site_oc_prima_deshecha_1",
        name="Prima Deshecha Landfill",
        lat=33.4939,
        lng=-117.6141,
        site_type="landfill",
        accepted_types=["mixed_waste", "yard_waste", "household_hazardous_waste"],
        hours="Mon-Sat 7:00 AM - 5:00 PM",
        address="32250 Avenida La Pata, San Juan Capistrano, CA 92675",
        maps_url="https://www.google.com/maps/search/?api=1&query=Prima+Deshecha+Landfill+32250+Avenida+La+Pata+San+Juan+Capistrano+CA+92675",
    ),
    DisposalSite(
        id="site_oc_olinda_alpha_1",
        name="Olinda Alpha Landfill",
        lat=33.9478,
        lng=-117.8510,
        site_type="landfill",
        accepted_types=["public_disposal", "commercial_solid_waste"],
        hours="Mon-Sat 7:00 AM - 4:00 PM",
        address="1942 N Valencia Ave, Brea, CA 92823",
        maps_url="https://www.google.com/maps/search/?api=1&query=Olinda+Alpha+Landfill+1942+N+Valencia+Ave+Brea+CA+92823",
    ),
    DisposalSite(
        id="site_oc_ocwr_transfer_1",
        name="OC Recycling & Transfer Station",
        lat=33.8514,
        lng=-117.8638,
        site_type="transfer_station",
        accepted_types=["recyclables", "solid_waste"],
        hours="Tue-Sat 9:00 AM - 3:00 PM",
        address="1071 N Blue Gum St, Anaheim, CA 92806",
        maps_url="https://www.google.com/maps/search/?api=1&query=OC+Recycling+%26+Transfer+Station+1071+N+Blue+Gum+St+Anaheim+CA+92806",
    ),
    DisposalSite(
        id="site_oc_hhw_hb_1",
        name="OC Household Hazardous Waste Collection Center",
        lat=33.6909,
        lng=-117.9984,
        site_type="household_hazardous_waste",
        accepted_types=["household_hazardous_waste", "e_waste"],
        hours="Tue-Sat (Check county schedule)",
        address="17121 Nichols Ln, Huntington Beach, CA 92647",
        maps_url="https://www.google.com/maps/search/?api=1&query=OC+Household+Hazardous+Waste+Collection+Center+17121+Nichols+Ln+Huntington+Beach+CA+92647",
    ),
    DisposalSite(
        id="site_sf_recology_transfer_1",
        name="SF Transfer Station (Recology)",
        lat=37.7424,
        lng=-122.3902,
        site_type="transfer_station",
        accepted_types=["mixed_waste", "construction_debris", "recyclables"],
        hours="Mon-Fri 7:00 AM - 4:30 PM; Sat-Sun 7:30 AM - 4:00 PM",
        address="501 Tunnel Ave, San Francisco, CA 94134",
        maps_url="https://www.google.com/maps/search/?api=1&query=SF+Transfer+Station+Recology+501+Tunnel+Ave+San+Francisco+CA+94134",
    ),
    DisposalSite(
        id="site_berkeley_transfer_1",
        name="Berkeley Transfer Station",
        lat=37.8796,
        lng=-122.3059,
        site_type="transfer_station",
        accepted_types=["refuse", "c_and_d_debris", "yard_waste", "recyclables"],
        hours="Mon-Sat 8:00 AM - 4:30 PM",
        address="1201 Second St, Berkeley, CA 94710",
        maps_url="https://www.google.com/maps/search/?api=1&query=Berkeley+Transfer+Station+1201+Second+St+Berkeley+CA+94710",
    ),
    DisposalSite(
        id="site_davis_st_transfer_1",
        name="Davis Street Transfer Station",
        lat=37.7228,
        lng=-122.1777,
        site_type="transfer_station",
        accepted_types=["municipal_solid_waste", "recyclables"],
        hours="Mon-Fri 7:00 AM - 5:00 PM; Sat 8:00 AM - 4:00 PM",
        address="2615 Davis St, San Leandro, CA 94577",
        maps_url="https://www.google.com/maps/search/?api=1&query=Davis+Street+Transfer+Station+2615+Davis+St+San+Leandro+CA+94577",
    ),
    DisposalSite(
        id="site_sf_recology_san_bruno_1",
        name="San Bruno Transfer Station (Recology)",
        lat=37.6406,
        lng=-122.4127,
        site_type="transfer_station",
        accepted_types=["household_hazardous_waste", "recyclables"],
        hours="Tue & Thu (HHW hours; check before visit)",
        address="101 Tanforan Ave, San Bruno, CA 94066",
        maps_url="https://www.google.com/maps/search/?api=1&query=San+Bruno+Transfer+Station+101+Tanforan+Ave+San+Bruno+CA+94066",
    ),
    DisposalSite(
        id="site_kirby_canyon_1",
        name="Kirby Canyon Recycling & Disposal Facility",
        lat=37.2208,
        lng=-121.7774,
        site_type="landfill",
        accepted_types=["municipal_solid_waste", "recyclables", "yard_trimmings"],
        hours="Public hours vary by day (check WM site)",
        address="910 Coyote Creek Golf Dr, San Jose, CA 95120",
        maps_url="https://www.google.com/maps/search/?api=1&query=Kirby+Canyon+Recycling+%26+Disposal+Facility+910+Coyote+Creek+Golf+Dr+San+Jose+CA+95120",
    ),
]


def _nearby_disposal_sites_static(lat: float, lng: float, limit: int) -> list[dict[str, Any]]:
    capped_limit = max(1, min(limit, 10))
    ranked = sorted(
        (site for site in DISPOSAL_SITES if site.active),
        key=lambda site: _haversine_km(lat, lng, site.lat, site.lng),
    )
    results: list[dict[str, Any]] = []
    for site in ranked[:capped_limit]:
        distance = _haversine_km(lat, lng, site.lat, site.lng)
        results.append(
            {
                "site_id": site.id,
                "name": site.name,
                "lat": site.lat,
                "lng": site.lng,
                "site_type": site.site_type,
                "accepted_types": site.accepted_types,
                "hours": site.hours,
                "address": site.address,
                "maps_url": site.maps_url,
                "distance_km": round(distance, 2),
            }
        )
    return results


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

    def upload_detection_image(self, image_bytes: bytes, filename: str) -> str | None:
        ...

    def get_nearby_disposal_sites(self, lat: float, lng: float, limit: int = 3) -> list[dict[str, Any]]:
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
                    "estimated_waste_kg": compute_estimated_waste_kg(total_size),
                    "cleanup_time_minutes": compute_cleanup_time_minutes(pile_count),
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

    def upload_detection_image(self, image_bytes: bytes, filename: str) -> str | None:
        return None

    def get_nearby_disposal_sites(self, lat: float, lng: float, limit: int = 3) -> list[dict[str, Any]]:
        return _nearby_disposal_sites_static(lat=lat, lng=lng, limit=limit)


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

    def upload_detection_image(self, image_bytes: bytes, filename: str) -> str | None:
        bucket = os.getenv("SUPABASE_STORAGE_BUCKET", "drone-images")
        safe_filename = "".join(ch if ch.isalnum() or ch in {".", "_", "-"} else "_" for ch in filename)
        object_path = f"detections/{utc_now().strftime('%Y/%m/%d')}/{uuid4().hex}_{safe_filename}"
        mime_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"

        upload_url = f"{self.base_url}/storage/v1/object/{bucket}/{quote(object_path, safe='/')}"
        upload_headers = {
            "apikey": self.service_role_key,
            "Authorization": f"Bearer {self.service_role_key}",
            "Content-Type": mime_type,
            "x-upsert": "true",
        }
        upload_req = request.Request(upload_url, data=image_bytes, headers=upload_headers, method="POST")
        try:
            with request.urlopen(upload_req, timeout=30):
                pass
        except error.HTTPError as exc:
            detail = exc.read().decode("utf-8")
            raise RuntimeError(f"Supabase storage upload failed: {detail}") from exc
        except error.URLError as exc:
            raise RuntimeError(f"Supabase storage upload failed: {exc}") from exc

        signed_ttl_seconds = int(os.getenv("SUPABASE_STORAGE_SIGNED_URL_TTL_SECONDS", "0"))
        if signed_ttl_seconds > 0:
            sign_url = f"{self.base_url}/storage/v1/object/sign/{bucket}"
            sign_payload = json.dumps({"paths": [object_path], "expiresIn": signed_ttl_seconds}).encode("utf-8")
            sign_headers = {
                "apikey": self.service_role_key,
                "Authorization": f"Bearer {self.service_role_key}",
                "Content-Type": "application/json",
            }
            sign_req = request.Request(sign_url, data=sign_payload, headers=sign_headers, method="POST")
            try:
                with request.urlopen(sign_req, timeout=30) as response:
                    signed = json.loads(response.read().decode("utf-8"))
                    first = signed[0] if isinstance(signed, list) and signed else signed
                    signed_url = first.get("signedURL") if isinstance(first, dict) else None
                    if signed_url:
                        if signed_url.startswith("http://") or signed_url.startswith("https://"):
                            return signed_url
                        return f"{self.base_url}/storage/v1{signed_url}"
            except error.HTTPError as exc:
                detail = exc.read().decode("utf-8")
                raise RuntimeError(f"Supabase storage sign failed: {detail}") from exc
            except error.URLError as exc:
                raise RuntimeError(f"Supabase storage sign failed: {exc}") from exc

        return f"{self.base_url}/storage/v1/object/public/{bucket}/{quote(object_path, safe='/')}"

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

    def get_nearby_disposal_sites(self, lat: float, lng: float, limit: int = 3) -> list[dict[str, Any]]:
        try:
            return self._rpc(
                "get_nearby_disposal_sites",
                {"lat_in": lat, "lng_in": lng, "limit_in": max(1, min(limit, 10))},
            )
        except RuntimeError:
            # Local fallback keeps demos working even if RPC hasn't been applied yet.
            return _nearby_disposal_sites_static(lat=lat, lng=lng, limit=limit)


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
