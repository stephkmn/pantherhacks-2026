"""Offline-safe YOLO integration helpers for the API layer."""

from __future__ import annotations

import io
import os
from pathlib import Path
from typing import Any

from PIL import Image, UnidentifiedImageError

TRASH_CLASSES = {
    0: "plastic_bottle",
    1: "glass_bottle",
    2: "aluminum_can",
    3: "plastic_bag",
    4: "food_wrapper",
    5: "cardboard",
    6: "paper",
    7: "styrofoam",
}

WEIGHT_ESTIMATES = {
    "plastic_bottle": 0.05,
    "glass_bottle": 0.3,
    "aluminum_can": 0.015,
    "plastic_bag": 0.008,
    "food_wrapper": 0.005,
    "cardboard": 0.1,
    "paper": 0.002,
    "styrofoam": 0.01,
}

_MODEL = None
_MODEL_ERROR: str | None = None


def _get_model() -> Any:
    """Lazily load YOLO model; never raise to callers."""
    global _MODEL, _MODEL_ERROR

    if _MODEL is not None:
        return _MODEL
    if _MODEL_ERROR is not None:
        return None

    model_path = os.getenv("YOLO_MODEL_PATH", "yolov8n.pt")
    if model_path == "yolov8n.pt" and not Path(model_path).exists():
        _MODEL_ERROR = (
            "YOLO weights not found locally. Set YOLO_MODEL_PATH to a local .pt file."
        )
        return None

    try:
        from ultralytics import YOLO

        _MODEL = YOLO(model_path)
        return _MODEL
    except Exception as exc:  # pragma: no cover - depends on local ML runtime
        _MODEL_ERROR = f"Unable to initialize YOLO model: {exc}"
        return None


def estimate_waste_from_detections(detections: list[dict[str, Any]]) -> float:
    total_weight = 0.0
    for detection in detections:
        object_class = detection.get("class", "unknown")
        total_weight += WEIGHT_ESTIMATES.get(object_class, 0.05)
    return round(total_weight, 2)


def convert_detections_to_hotspot(
    detections: list[dict[str, Any]],
    drone_lat: float,
    drone_lng: float,
) -> dict[str, Any] | None:
    if not detections:
        return None

    waste_types: dict[str, int] = {}
    for det in detections:
        class_name = det["class"]
        waste_types[class_name] = waste_types.get(class_name, 0) + 1

    total_objects = len(detections)
    if total_objects > 20:
        severity = "high"
    elif total_objects > 10:
        severity = "medium"
    else:
        severity = "low"

    cleanup_minutes = max(10, int(total_objects / 2))
    avg_confidence = sum(float(d["confidence"]) for d in detections) / total_objects

    return {
        "lat": drone_lat,
        "lng": drone_lng,
        "severity": severity,
        "waste_types": sorted(waste_types.keys()),
        "estimated_waste_kg": estimate_waste_from_detections(detections),
        "cleanup_time_minutes": cleanup_minutes,
        "confidence": round(avg_confidence, 2),
        "object_count": total_objects,
        "object_breakdown": waste_types,
    }


def detect_trash_yolo_from_bytes(
    image_bytes: bytes,
    filename: str,
    confidence_threshold: float = 0.5,
) -> dict[str, Any]:
    """
    Run real YOLO detection when available, otherwise return deterministic fallback.
    """
    try:
        image = Image.open(io.BytesIO(image_bytes))
    except UnidentifiedImageError:
        return {
            "status": "fallback",
            "message": "Invalid image format.",
            "filename": filename,
            "model_loaded": False,
            "fallback_reason": "unable_to_parse_image",
            "detections": [],
            "total_objects": 0,
            "average_confidence": 0.0,
            "image_size": [0, 0],
            "estimated_waste_kg": 0.0,
        }

    model = _get_model()
    if model is None:
        return {
            "status": "fallback",
            "message": "YOLO unavailable; returning empty detections.",
            "filename": filename,
            "model_loaded": False,
            "fallback_reason": _MODEL_ERROR or "model_unavailable",
            "detections": [],
            "total_objects": 0,
            "average_confidence": 0.0,
            "image_size": list(image.size),
            "estimated_waste_kg": 0.0,
        }

    try:
        results = model(image, conf=confidence_threshold)
        detections: list[dict[str, Any]] = []
        total_confidence = 0.0

        for result in results:
            for box in result.boxes:
                class_id = int(box.cls[0])
                confidence = float(box.conf[0])
                bbox = [float(v) for v in box.xyxy[0].tolist()]
                class_name = TRASH_CLASSES.get(class_id, model.names.get(class_id, "unknown"))
                detections.append(
                    {
                        "class": class_name,
                        "confidence": round(confidence, 2),
                        "bbox": bbox,
                    }
                )
                total_confidence += confidence

        avg_confidence = total_confidence / len(detections) if detections else 0.0
        return {
            "status": "ok",
            "message": "Image analyzed successfully.",
            "filename": filename,
            "model_loaded": True,
            "fallback_reason": None,
            "detections": detections,
            "total_objects": len(detections),
            "average_confidence": round(avg_confidence, 2),
            "image_size": list(image.size),
            "estimated_waste_kg": estimate_waste_from_detections(detections),
        }
    except Exception as exc:  # pragma: no cover - depends on local ML runtime
        return {
            "status": "fallback",
            "message": "YOLO inference failed; returning empty detections.",
            "filename": filename,
            "model_loaded": False,
            "fallback_reason": f"inference_error: {exc}",
            "detections": [],
            "total_objects": 0,
            "average_confidence": 0.0,
            "image_size": list(image.size),
            "estimated_waste_kg": 0.0,
        }
