# PantherHacks 2026 MVP

## Environment

Use `.env` for backend variables only.

Required:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` (backend-only, never expose to frontend code)
- `INGEST_API_KEY`

Optional:
- `SUPABASE_STORAGE_BUCKET` (default: `drone-images`)
- `SUPABASE_STORAGE_SIGNED_URL_TTL_SECONDS` (0 = public URL)
- `YOLO_MODEL_PATH`
- `ENABLE_HOURLY_ROUND_AUTOMATION`
- `AUTO_ROUND_PREFIX`

### Dev vs Prod
- Dev: set `ENABLE_HOURLY_ROUND_AUTOMATION=false`
- Prod: set `ENABLE_HOURLY_ROUND_AUTOMATION=true` and schedule DB job with `public.start_new_round_auto()` via `pg_cron`.

## Start Scripts

- Local dev (backend + frontend):
  - `./scripts/start-local.sh`
- Production-like run (build + serve + backend):
  - `./scripts/start-prod.sh`

## Ingest Auth

Write endpoints require auth via either:
- `X-API-Key: <INGEST_API_KEY>`
- `Authorization: Bearer <INGEST_API_KEY>`

Protected endpoints:
- `POST /api/rounds/start`
- `POST /api/drone-position`
- `POST /api/trash-entry`
- `POST /api/detect-image`

## MVP Acceptance Runbook

1. Apply SQL migration and seed data:
- `backend/supabase/migrations/001_hourly_drone_trash.sql`
- `backend/supabase/seeds/seed_orange_county_zip_centroids.sql`
- `backend/supabase/seeds/seed_bay_area_zip_centroids.sql`
- `backend/supabase/seeds/seed_trash_entries_from_zip_centroids.sql`

2. Start app:
- `./scripts/start-local.sh`

3. Scan ZIP in UI:
- Open app and scan `92801`.
- Verify hotspot cards show API metric values and real photo URLs.

4. Insert a new trash entry via API:
```bash
curl -X POST http://localhost:8000/api/trash-entry \
  -H "Content-Type: application/json" \
  -H "X-API-Key: dev-ingest-key" \
  -d '{
    "round_id":"round_manual_1",
    "drone_id":"drone_1",
    "lat":33.8428,
    "lng":-117.9546,
    "size":8,
    "meta":{"photo_url":"https://example.com/test.jpg"}
  }'
```

5. (Optional) Upload image and persist detections:
```bash
curl -X POST http://localhost:8000/api/detect-image \
  -H "X-API-Key: dev-ingest-key" \
  -F "file=@backend/tests/test_images/garbage_1.jpg" \
  -F "round_id=round_manual_1" \
  -F "drone_id=drone_1" \
  -F "lat=33.8428" \
  -F "lng=-117.9546"
```

6. Re-scan same ZIP in UI:
- Verify hotspot score/color and image reflect newly inserted entries.

7. Route behavior:
- Use skip/restore in UI and confirm route updates.
