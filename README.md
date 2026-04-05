# SkySweep

SkySweep is a computer-vision-powered trash detection platform built for PantherHacks 2026. It helps communities find litter, document it with photos and location data, and turn those observations into actionable cleanup plans.

At its core, SkySweep answers a simple problem: trash is easy to overlook, hard to report consistently, and expensive to clean up once it spreads. Instead of relying on manual reports alone, SkySweep treats litter as something that can be detected, mapped, prioritized, and responded to in real time.

The system uses camera input from a drone, a phone, or an uploaded image to detect visible waste, draw bounding boxes around it, save the evidence, and create location-aware records in the database. Those records can then be grouped into hotspots, scored by severity, and used to plan cleanup routes.

In the live demo experience, a user can walk around with a phone camera while SkySweep watches for trash, uploads detected frames, and records new trash entries automatically. The result is a project that feels less like a static reporting tool and more like an environmental operations platform.

## What It Does

SkySweep helps users:

- detect trash in images using a YOLO-based computer vision pipeline
- capture photos of detected trash and upload them to cloud storage
- create geotagged `trash_entries` that can be viewed and analyzed later
- cluster nearby trash reports into hotspots
- estimate waste volume, cleanup time, and severity
- generate cleanup routes through active hotspots
- suggest nearby disposal sites for collected waste

In the current demo flow, a user can open the mobile camera experience, walk around a building, and let the app watch for trash in a live feed. When trash is detected, the interface draws bounding boxes on screen, uploads the captured frame, writes the detection to the database, and shows a confirmation notification.

## Why It Matters

Litter is easy to ignore when reporting is slow, inconsistent, or entirely manual. That leads to delayed cleanup, poor visibility into problem areas, and wasted time for teams trying to respond. SkySweep turns scattered observations into structured environmental data.

Instead of asking someone to remember where trash was seen and describe it later, the system captures:

- where the trash was found
- when it was found
- what the camera saw
- how severe the area appears to be
- how to prioritize cleanup

This makes the project useful not just as a demo, but as a foundation for campus cleanup operations, municipal pilot programs, park monitoring, and autonomous drone inspections.

## How It Works

SkySweep has two main parts:

1. Frontend

The React frontend provides:

- a dashboard for scanning ZIP codes and viewing hotspots on a map
- route visualization for cleanup planning
- hotspot detail views with waste estimates and nearby disposal sites
- a mobile live-camera demo mode for real-time trash detection

2. Backend

The FastAPI backend provides:

- image detection endpoints
- ingest-protected write endpoints for rounds, drone positions, and trash entries
- hotspot aggregation and scoring
- disposal-site lookup
- integration with Supabase storage and database services

When a detection image is uploaded, the backend can:

- run the YOLO detector
- estimate detected trash quantity
- upload the image to the storage bucket
- create one or more `trash_entries`
- expose the saved photo URL and detection metadata back to the client

## Demo Experience

SkySweep supports multiple ways to demonstrate the system:

- ZIP scan mode: simulate area scans and visualize hotspots on the dashboard
- image detection mode: upload a trash image and persist detections
- mobile live demo: use a phone camera as a stand-in for a drone feed

The mobile live demo is especially helpful for showing the real product vision. It mimics how an aerial or moving camera system could continuously detect litter, mark it visually, and write findings into the platform as the operator moves through a space.

## Tech Stack

- React + Vite frontend
- FastAPI backend
- YOLO / Ultralytics-based image detection
- Supabase database and storage
- Leaflet for mapping

## Project Vision

SkySweep is designed as more than a map of trash pins. The long-term goal is an environmental operations tool that helps communities identify waste buildup early, prioritize cleanup resources, and build a clearer picture of recurring pollution patterns.

Future directions could include:

- true drone video ingestion
- real-time streaming inference
- autonomous patrol routes
- trend analysis across time and geography
- alerts for newly formed hotspots
- cleaner handoff from detection to cleanup crews

## Running It Locally

If you want to explore the project yourself:

1. Create a `.env` file with backend credentials.
2. Start the app with:

```bash
./scripts/start-local.sh
```

This launches:

- the FastAPI backend on `http://localhost:8000`
- the Vite frontend on `http://localhost:5173`

## Environment Variables

Required:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `INGEST_API_KEY`

Optional:

- `SUPABASE_STORAGE_BUCKET`
- `SUPABASE_STORAGE_SIGNED_URL_TTL_SECONDS`
- `YOLO_MODEL_PATH`
- `ENABLE_HOURLY_ROUND_AUTOMATION`
- `AUTO_ROUND_PREFIX`
- `VITE_GOOGLE_MAPS_API_KEY`
- `ngrok_url` or `NGROK_URL`

## API Overview

Some of the main backend endpoints include:

- `POST /api/detect-image`
- `POST /api/trash-entry`
- `POST /api/rounds/start`
- `POST /api/drone-position`
- `GET /api/hotspots`
- `GET /api/disposal-sites/nearby`
- `POST /api/optimize-route`

Protected ingest endpoints require either:

- `X-API-Key: <INGEST_API_KEY>`
- `Authorization: Bearer <INGEST_API_KEY>`

## Team

Built for PantherHacks 2026 as a prototype for smarter, faster environmental cleanup coordination.
