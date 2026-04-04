from fastapi import FastAPI, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Optional
import random
import numpy as np
from datetime import datetime

app = FastAPI(title="CleanSky AI API")

# CORS middleware for React frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Models
class TrashHotspot(BaseModel):
    id: str
    name: str
    lat: float
    lng: float
    severity: str  # "high", "medium", "low"
    waste_types: List[str]
    estimated_waste_kg: float
    cleanup_time_minutes: int
    confidence: float
    detected_at: str

class ScanRequest(BaseModel):
    center_lat: float
    center_lng: float
    radius_km: float = 2.0

class RouteResponse(BaseModel):
    hotspots: List[TrashHotspot]
    total_distance_km: float
    total_time_minutes: int
    total_waste_kg: float
    route_coordinates: List[List[float]]

# Simulated trash detection (replace with real YOLO/Roboflow later)
@app.post("/api/scan", response_model=List[TrashHotspot])
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
            ["high", "medium", "low"],
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
            detected_at=datetime.now().isoformat()
        )
        hotspots.append(hotspot)
    
    return hotspots


@app.post("/api/optimize-route", response_model=RouteResponse)
async def optimize_cleanup_route(hotspots: List[TrashHotspot]):
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
    severity_weight = {"high": 3, "medium": 2, "low": 1}
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


@app.post("/api/detect-image")
async def detect_trash_in_image(file: UploadFile = File(...)):
    """
    Endpoint for actual image-based trash detection
    TODO: Integrate YOLO or Roboflow model here
    
    Example integration:
    - Load image with PIL/OpenCV
    - Run through YOLO model
    - Return bounding boxes and classifications
    """
    
    # Placeholder for now - will integrate real CV model
    return {
        "message": "Image received - integrate YOLO/Roboflow here",
        "filename": file.filename,
        "detections": [
            {"class": "plastic_bottle", "confidence": 0.92, "bbox": [100, 200, 150, 300]},
            {"class": "food_wrapper", "confidence": 0.88, "bbox": [300, 150, 380, 250]}
        ]
    }


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
            "scan": "/api/scan",
            "optimize_route": "/api/optimize-route",
            "detect_image": "/api/detect-image",
            "health": "/api/health"
        }
    }