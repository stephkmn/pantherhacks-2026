import asyncio
from datetime import datetime, timedelta, timezone
from enum import Enum
import os
from pathlib import Path
import random
from typing import Any
from uuid import uuid4

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from backend.data_store import (
    DEFAULT_RADIUS_KM,
    MAX_RADIUS_KM,
    compute_cleanup_time_minutes,
    compute_estimated_waste_kg,
    get_data_store,
)
from backend.yolo_integration import detect_trash_yolo_from_bytes

load_dotenv(dotenv_path=Path(__file__).resolve().parents[1] / ".env")

app = FastAPI(title="CleanSky AI API")

# CORS middleware for React frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class Severity(str, Enum):
    high = "high"
    medium = "medium"
    low = "low"


# Models
class TrashHotspot(BaseModel):
    id: str
    name: str
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)
    severity: Severity
    waste_types: list[str]
    estimated_waste_kg: float = Field(ge=0)
    cleanup_time_minutes: int = Field(ge=0)
    confidence: float = Field(ge=0, le=1)
    detected_at: datetime

class ScanRequest(BaseModel):
    center_lat: float = Field(ge=-90, le=90)
    center_lng: float = Field(ge=-180, le=180)
    radius_km: float = Field(default=2.0, gt=0, le=10)

class RouteResponse(BaseModel):
    hotspots: list[TrashHotspot]
    total_distance_km: float
    total_time_minutes: int
    total_waste_kg: float
    route_coordinates: list[list[float]]


class Detection(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    class_name: str = Field(alias="class")
    confidence: float = Field(ge=0, le=1)
    bbox: list[float] = Field(min_length=4, max_length=4)


class DetectImageResponse(BaseModel):
    status: str
    message: str
    filename: str
    model_loaded: bool
    fallback_reason: str | None = None
    detections: list[Detection]
    total_objects: int = Field(ge=0)
    average_confidence: float = Field(ge=0, le=1)
    image_size: list[int] = Field(min_length=2, max_length=2)
    estimated_waste_kg: float = Field(ge=0)
    photo_url: str | None = None
    persisted_entries: list[dict[str, Any]] = Field(default_factory=list)
    persisted_detection_count: int = Field(default=0, ge=0)
    persistence_skipped_reason: str | None = None


class ErrorEnvelope(BaseModel):
    error: dict[str, Any]


class RoundStartRequest(BaseModel):
    drone_round_id: str | None = None


class RoundResponse(BaseModel):
    id: str
    started_at: datetime
    ended_at: datetime | None
    status: str


class DronePositionUpsertRequest(BaseModel):
    round_id: str
    drone_id: str
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)
    recorded_at: datetime | None = None


class DronePositionResponse(BaseModel):
    round_id: str
    drone_id: str
    recorded_at: datetime
    lat: float
    lng: float


class TrashEntryCreateRequest(BaseModel):
    round_id: str
    drone_id: str
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)
    size: int = Field(ge=1, le=10)
    detected_at: datetime | None = None
    meta: dict[str, Any] = Field(default_factory=dict)


class TrashEntryResponse(BaseModel):
    id: str
    round_id: str
    drone_id: str
    detected_at: datetime
    lat: float
    lng: float
    size: int
    meta: dict[str, Any]


class HotspotColor(str, Enum):
    green = "green"
    yellow = "yellow"
    red = "red"


class ZipHotspotResponse(BaseModel):
    hotspot_id: str
    lat: float
    lng: float
    pile_count: int
    avg_size: float
    total_size: int
    score: float
    color: HotspotColor
    estimated_waste_kg: float = Field(ge=0)
    cleanup_time_minutes: int = Field(ge=0)
    last_detected_at: datetime
    photo_url: str | None = None


class DisposalSiteResponse(BaseModel):
    site_id: str
    name: str
    lat: float
    lng: float
    site_type: str
    accepted_types: list[str]
    hours: str
    address: str
    maps_url: str
    distance_km: float


def _data_store():
    return get_data_store()


INGEST_API_KEY = os.getenv("INGEST_API_KEY", "dev-ingest-key")
ENABLE_HOURLY_ROUND_AUTOMATION = os.getenv("ENABLE_HOURLY_ROUND_AUTOMATION", "false").lower() == "true"
AUTO_ROUND_PREFIX = os.getenv("AUTO_ROUND_PREFIX", "auto_round")
_hourly_round_task: asyncio.Task | None = None


def _extract_ingest_token(
    authorization: str | None,
    x_api_key: str | None,
) -> str | None:
    if x_api_key:
        return x_api_key.strip()
    if authorization and authorization.lower().startswith("bearer "):
        return authorization[7:].strip()
    return None


def require_ingest_auth(
    authorization: str | None = Header(default=None),
    x_api_key: str | None = Header(default=None, alias="X-API-Key"),
) -> None:
    provided_token = _extract_ingest_token(authorization=authorization, x_api_key=x_api_key)
    if not provided_token:
        raise HTTPException(
            status_code=401,
            detail={
                "code": "UNAUTHORIZED",
                "message": "Missing ingest token. Provide Bearer token or X-API-Key.",
            },
        )
    if provided_token != INGEST_API_KEY:
        raise HTTPException(
            status_code=403,
            detail={
                "code": "FORBIDDEN",
                "message": "Invalid ingest token.",
            },
        )


def _seconds_until_next_hour() -> float:
    now = datetime.now(timezone.utc)
    next_hour = (now.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1))
    return max(1.0, (next_hour - now).total_seconds())


async def _hourly_round_worker() -> None:
    while True:
        await asyncio.sleep(_seconds_until_next_hour())
        round_id = f"{AUTO_ROUND_PREFIX}_{datetime.now(timezone.utc).strftime('%Y%m%d%H00')}_{uuid4().hex[:6]}"
        _data_store().start_new_round(round_id=round_id)


def _size_from_bbox(bbox: list[float], image_size: list[int]) -> int:
    width, height = image_size
    if width <= 0 or height <= 0:
        return 1
    x1, y1, x2, y2 = bbox
    bbox_width = max(0.0, x2 - x1)
    bbox_height = max(0.0, y2 - y1)
    area_ratio = (bbox_width * bbox_height) / float(width * height)
    return min(10, max(1, int(round(area_ratio * 20)) or 1))


@app.exception_handler(RequestValidationError)
async def request_validation_exception_handler(_, exc: RequestValidationError):
    return JSONResponse(
        status_code=422,
        content={
            "error": {
                "code": "VALIDATION_ERROR",
                "message": "Request validation failed.",
                "details": exc.errors(),
            }
        },
    )


@app.exception_handler(HTTPException)
async def http_exception_handler(_, exc: HTTPException):
    detail = exc.detail
    if isinstance(detail, dict) and "code" in detail and "message" in detail:
        error = detail
    else:
        error = {"code": "HTTP_ERROR", "message": str(detail)}
    return JSONResponse(status_code=exc.status_code, content={"error": error})


@app.post("/api/rounds/start", response_model=RoundResponse, dependencies=[Depends(require_ingest_auth)])
async def start_round(payload: RoundStartRequest):
    round_id = payload.drone_round_id or f"round_{uuid4().hex[:12]}"
    round_model = _data_store().start_new_round(round_id=round_id)
    return RoundResponse(
        id=round_model.id,
        started_at=round_model.started_at,
        ended_at=round_model.ended_at,
        status=round_model.status,
    )


@app.post("/api/drone-position", response_model=DronePositionResponse, dependencies=[Depends(require_ingest_auth)])
async def upsert_drone_position(payload: DronePositionUpsertRequest):
    record = _data_store().upsert_drone_position(
        round_id=payload.round_id,
        drone_id=payload.drone_id,
        lat=payload.lat,
        lng=payload.lng,
        recorded_at=payload.recorded_at,
    )
    return DronePositionResponse(
        round_id=record.round_id,
        drone_id=record.drone_id,
        recorded_at=record.recorded_at,
        lat=record.lat,
        lng=record.lng,
    )


@app.post("/api/trash-entry", response_model=TrashEntryResponse, dependencies=[Depends(require_ingest_auth)])
async def create_trash_entry(payload: TrashEntryCreateRequest):
    record = _data_store().insert_trash_entry(
        round_id=payload.round_id,
        drone_id=payload.drone_id,
        lat=payload.lat,
        lng=payload.lng,
        size=payload.size,
        detected_at=payload.detected_at,
        meta=payload.meta,
    )
    return TrashEntryResponse(
        id=record.id,
        round_id=record.round_id,
        drone_id=record.drone_id,
        detected_at=record.detected_at,
        lat=record.lat,
        lng=record.lng,
        size=record.size,
        meta=record.meta,
    )


@app.get("/api/hotspots", response_model=list[ZipHotspotResponse])
async def get_hotspots(zip: str, radius_km: float = DEFAULT_RADIUS_KM):
    if radius_km <= 0 or radius_km > MAX_RADIUS_KM:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "INVALID_RADIUS",
                "message": f"radius_km must be between 0 and {MAX_RADIUS_KM}.",
            },
        )

    zip_code = zip.strip()
    try:
        hotspots = _data_store().get_hotspots_by_zip(zip_code=zip_code, radius_km=radius_km)
    except KeyError as exc:
        if str(exc).strip("'") == "zip_not_found":
            raise HTTPException(
                status_code=404,
                detail={
                    "code": "ZIP_NOT_FOUND",
                    "message": f"ZIP code {zip_code} was not found in centroid lookup.",
                },
            ) from exc
        raise
    except RuntimeError as exc:
        raise HTTPException(
            status_code=500,
            detail={
                "code": "DATA_STORE_ERROR",
                "message": str(exc),
            },
        ) from exc

    return [
        ZipHotspotResponse(
            hotspot_id=item["hotspot_id"],
            lat=item["lat"],
            lng=item["lng"],
            pile_count=item["pile_count"],
            avg_size=item["avg_size"],
            total_size=item["total_size"],
            score=item["score"],
            color=item["color"],
            estimated_waste_kg=round(float(item.get("estimated_waste_kg", compute_estimated_waste_kg(item["total_size"]))), 2),
            cleanup_time_minutes=int(item.get("cleanup_time_minutes", compute_cleanup_time_minutes(item["pile_count"]))),
            last_detected_at=datetime.fromisoformat(item["last_detected_at"]),
            photo_url=item.get("photo_url"),
        )
        for item in hotspots
    ]


@app.get("/api/disposal-sites/nearby", response_model=list[DisposalSiteResponse])
async def get_nearby_disposal_sites(lat: float, lng: float, limit: int = 3):
    if lat < -90 or lat > 90:
        raise HTTPException(
            status_code=400,
            detail={"code": "INVALID_LAT", "message": "lat must be between -90 and 90."},
        )
    if lng < -180 or lng > 180:
        raise HTTPException(
            status_code=400,
            detail={"code": "INVALID_LNG", "message": "lng must be between -180 and 180."},
        )
    if limit < 1 or limit > 10:
        raise HTTPException(
            status_code=400,
            detail={"code": "INVALID_LIMIT", "message": "limit must be between 1 and 10."},
        )

    try:
        sites = _data_store().get_nearby_disposal_sites(lat=lat, lng=lng, limit=limit)
    except RuntimeError as exc:
        raise HTTPException(
            status_code=500,
            detail={"code": "DATA_STORE_ERROR", "message": str(exc)},
        ) from exc
    return [
        DisposalSiteResponse(
            site_id=str(site["site_id"]),
            name=str(site["name"]),
            lat=float(site["lat"]),
            lng=float(site["lng"]),
            site_type=str(site["site_type"]),
            accepted_types=[str(item) for item in (site.get("accepted_types") or [])],
            hours=str(site.get("hours") or "Hours unavailable"),
            address=str(site.get("address") or "Address unavailable"),
            maps_url=str(
                site.get("maps_url")
                or f"https://www.google.com/maps/search/?api=1&query={float(site['lat'])},{float(site['lng'])}"
            ),
            distance_km=round(float(site.get("distance_km", 0.0)), 2),
        )
        for site in sites
    ]

# Simulated trash detection (replace with real YOLO/Roboflow later)
@app.post("/api/scan", response_model=list[TrashHotspot])
async def scan_area(scan_request: ScanRequest):
    """
    Simulates drone scanning an area and detecting trash hotspots
    In production: Replace with actual computer vision model
    """
    
    # Simulate detected hotspots around the center point
    hotspots = []
    
    # Predefined trash types for simulation
    waste_type_options = [
        ["plastic bottles", "food packaging", "shopping bags"],
        ["aluminum cans", "glass bottles", "plastic containers"],
        ["cardboard boxes", "paper waste", "plastic wrap"],
        ["cigarette butts", "plastic cups", "straws"],
        ["food wrappers", "beverage containers", "disposable plates"]
    ]
    
    location_names = [
        "Central Park Area",
        "Downtown Riverbank", 
        "Market Street Alley",
        "Beach Boulevard",
        "Harbor Park",
        "Shopping District",
        "Metro Station Plaza"
    ]
    
    # Generate 5-7 random hotspots
    num_hotspots = random.randint(5, 7)
    
    for i in range(num_hotspots):
        # Random offset from center (within radius)
        lat_offset = random.uniform(-0.02, 0.02)
        lng_offset = random.uniform(-0.02, 0.02)
        
        # Random severity based on weights
        severity = random.choices(
            [Severity.high, Severity.medium, Severity.low],
            weights=[0.3, 0.5, 0.2]
        )[0]
        
        # Waste amount based on severity
        if severity == "high":
            waste_kg = round(random.uniform(3.0, 5.0), 1)
            cleanup_time = random.randint(20, 30)
        elif severity == "medium":
            waste_kg = round(random.uniform(1.5, 3.0), 1)
            cleanup_time = random.randint(12, 20)
        else:
            waste_kg = round(random.uniform(0.5, 1.5), 1)
            cleanup_time = random.randint(8, 15)
        
        hotspot = TrashHotspot(
            id=f"hotspot_{i}_{datetime.now().timestamp()}",
            name=random.choice(location_names),
            lat=scan_request.center_lat + lat_offset,
            lng=scan_request.center_lng + lng_offset,
            severity=severity,
            waste_types=random.choice(waste_type_options),
            estimated_waste_kg=waste_kg,
            cleanup_time_minutes=cleanup_time,
            confidence=round(random.uniform(0.85, 0.98), 2),
            detected_at=datetime.now()
        )
        hotspots.append(hotspot)
    
    return hotspots


@app.post("/api/optimize-route", response_model=RouteResponse)
async def optimize_cleanup_route(hotspots: list[TrashHotspot]):
    """
    Generates optimal cleanup route using greedy nearest neighbor algorithm
    Can be upgraded to use OR-Tools or genetic algorithms
    """
    
    if not hotspots:
        return RouteResponse(
            hotspots=[],
            total_distance_km=0,
            total_time_minutes=0,
            total_waste_kg=0,
            route_coordinates=[]
        )
    
    # Sort by severity first (prioritize high severity)
    severity_weight = {
        Severity.high: 3,
        Severity.medium: 2,
        Severity.low: 1,
    }
    sorted_hotspots = sorted(
        hotspots, 
        key=lambda x: severity_weight[x.severity], 
        reverse=True
    )
    
    # Simple nearest neighbor after severity sorting
    route = [sorted_hotspots[0]]
    remaining = sorted_hotspots[1:]
    
    while remaining:
        current = route[-1]
        # Find nearest unvisited hotspot
        nearest = min(
            remaining,
            key=lambda h: calculate_distance(current.lat, current.lng, h.lat, h.lng)
        )
        route.append(nearest)
        remaining.remove(nearest)
    
    # Calculate total metrics
    total_distance = sum(
        calculate_distance(
            route[i].lat, route[i].lng,
            route[i+1].lat, route[i+1].lng
        )
        for i in range(len(route) - 1)
    )
    
    total_time = sum(h.cleanup_time_minutes for h in route) + int(total_distance * 10)  # 10 min per km travel
    total_waste = sum(h.estimated_waste_kg for h in route)
    
    route_coords = [[h.lat, h.lng] for h in route]
    
    return RouteResponse(
        hotspots=route,
        total_distance_km=round(total_distance, 2),
        total_time_minutes=total_time,
        total_waste_kg=round(total_waste, 1),
        route_coordinates=route_coords
    )


@app.post(
    "/api/detect-image",
    response_model=DetectImageResponse,
    dependencies=[Depends(require_ingest_auth)],
    responses={
        400: {
            "model": ErrorEnvelope,
            "description": "Invalid input file type or missing payload.",
        }
    },
)
async def detect_trash_in_image(
    file: UploadFile = File(...),
    round_id: str | None = Form(default=None),
    drone_id: str | None = Form(default=None),
    lat: float | None = Form(default=None),
    lng: float | None = Form(default=None),
    detected_at: datetime | None = Form(default=None),
):
    """
    Endpoint for actual image-based trash detection
    TODO: Integrate YOLO or Roboflow model here
    
    Example integration:
    - Load image with PIL/OpenCV
    - Run through YOLO model
    - Return bounding boxes and classifications
    """
    
    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(
            status_code=400,
            detail={
                "code": "INVALID_CONTENT_TYPE",
                "message": "Only image uploads are supported.",
            },
        )

    contents = await file.read()
    if not contents:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "EMPTY_FILE",
                "message": "Uploaded file is empty.",
            },
        )

    yolo_result = detect_trash_yolo_from_bytes(contents, file.filename or "uploaded-image")
    mapped_detections = [
        {"class": det["class"], "confidence": det["confidence"], "bbox": det["bbox"]}
        for det in yolo_result["detections"]
    ]
    yolo_result["detections"] = mapped_detections

    ingest_fields = [round_id, drone_id, lat, lng]
    if any(value is not None for value in ingest_fields) and not all(value is not None for value in ingest_fields):
        raise HTTPException(
            status_code=400,
            detail={
                "code": "MISSING_INGEST_FIELDS",
                "message": "round_id, drone_id, lat, and lng are all required to persist detections.",
            },
        )

    photo_url: str | None = None
    persisted_entries: list[dict[str, Any]] = []
    persistence_skipped_reason: str | None = None
    if round_id is not None and drone_id is not None and lat is not None and lng is not None:
        if mapped_detections:
            try:
                ingest_lat = float(lat)
                ingest_lng = float(lng)
                photo_url = _data_store().upload_detection_image(contents, file.filename or "uploaded-image")
                record_time = detected_at or datetime.now(timezone.utc)
                for det in mapped_detections:
                    entry = _data_store().insert_trash_entry(
                        round_id=round_id,
                        drone_id=drone_id,
                        lat=ingest_lat,
                        lng=ingest_lng,
                        size=_size_from_bbox(det["bbox"], yolo_result["image_size"]),
                        detected_at=record_time,
                        meta={
                            "detection": det,
                            "photo_url": photo_url,
                            "source": "detect-image",
                            "filename": file.filename,
                        },
                    )
                    persisted_entries.append(
                        {
                            "id": entry.id,
                            "round_id": entry.round_id,
                            "drone_id": entry.drone_id,
                            "detected_at": entry.detected_at.isoformat(),
                            "lat": entry.lat,
                            "lng": entry.lng,
                            "size": entry.size,
                            "meta": entry.meta,
                        }
                    )
            except RuntimeError as exc:
                raise HTTPException(
                    status_code=502,
                    detail={
                        "code": "INGEST_PERSISTENCE_FAILED",
                        "message": (
                            f"Detection persistence failed: {exc}. "
                            "Verify SUPABASE_URL connectivity, storage bucket existence, and that round_id exists."
                        ),
                    },
                ) from exc
        else:
            persistence_skipped_reason = "no_detections"

    yolo_result["photo_url"] = photo_url
    yolo_result["persisted_entries"] = persisted_entries
    yolo_result["persisted_detection_count"] = len(persisted_entries)
    yolo_result["persistence_skipped_reason"] = persistence_skipped_reason
    return yolo_result


@app.on_event("startup")
async def startup_event():
    global _hourly_round_task
    if ENABLE_HOURLY_ROUND_AUTOMATION and _hourly_round_task is None:
        _hourly_round_task = asyncio.create_task(_hourly_round_worker())


@app.on_event("shutdown")
async def shutdown_event():
    global _hourly_round_task
    if _hourly_round_task:
        _hourly_round_task.cancel()
        _hourly_round_task = None


def calculate_distance(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Calculate distance between two points using Haversine formula"""
    from math import radians, sin, cos, sqrt, atan2
    
    R = 6371  # Earth's radius in km
    
    lat1, lng1, lat2, lng2 = map(radians, [lat1, lng1, lat2, lng2])
    dlat = lat2 - lat1
    dlng = lng2 - lng1
    
    a = sin(dlat/2)**2 + cos(lat1) * cos(lat2) * sin(dlng/2)**2
    c = 2 * atan2(sqrt(a), sqrt(1-a))
    
    return R * c


@app.get("/api/health")
async def health_check():
    return {"status": "healthy", "service": "CleanSky AI"}


@app.get("/")
async def root():
    return {
        "message": "CleanSky AI - Trash Detection API",
        "version": "1.0.0",
        "endpoints": {
            "start_round": "/api/rounds/start",
            "drone_position": "/api/drone-position",
            "trash_entry": "/api/trash-entry",
            "hotspots": "/api/hotspots?zip=92801&radius_km=2.0",
            "disposal_sites_nearby": "/api/disposal-sites/nearby?lat=33.84&lng=-117.95&limit=3",
            "scan": "/api/scan",
            "optimize_route": "/api/optimize-route",
            "detect_image": "/api/detect-image",
            "health": "/api/health"
        }
    }
