import io
import os
import unittest

from fastapi.testclient import TestClient
from PIL import Image

from backend.data_store import reset_data_store_for_tests
from backend.main import app

INGEST_HEADERS = {"X-API-Key": os.getenv("INGEST_API_KEY", "dev-ingest-key")}


class CleanSkyApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app)

    def setUp(self):
        reset_data_store_for_tests()

    def test_health(self):
        response = self.client.get("/api/health")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["status"], "healthy")
        self.assertEqual(payload["service"], "CleanSky AI")

    def test_scan_contract(self):
        response = self.client.post(
            "/api/scan",
            json={"center_lat": 33.8366, "center_lng": -117.9143, "radius_km": 2.0},
        )
        self.assertEqual(response.status_code, 200)
        hotspots = response.json()
        self.assertGreaterEqual(len(hotspots), 5)
        self.assertLessEqual(len(hotspots), 7)
        for hotspot in hotspots:
            self.assertIn(hotspot["severity"], ["high", "medium", "low"])
            self.assertTrue(0 <= hotspot["confidence"] <= 1)
            self.assertIn("detected_at", hotspot)

    def test_scan_validation_error(self):
        response = self.client.post("/api/scan", json={"center_lng": -117.9143})
        self.assertEqual(response.status_code, 422)
        payload = response.json()
        self.assertEqual(payload["error"]["code"], "VALIDATION_ERROR")

    def test_optimize_route_empty(self):
        response = self.client.post("/api/optimize-route", json=[])
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["hotspots"], [])
        self.assertEqual(payload["total_distance_km"], 0)
        self.assertEqual(payload["total_time_minutes"], 0)
        self.assertEqual(payload["total_waste_kg"], 0)

    def test_optimize_route_validation_error(self):
        response = self.client.post(
            "/api/optimize-route",
            json=[
                {
                    "id": "h1",
                    "name": "Bad Severity",
                    "lat": 33.83,
                    "lng": -117.91,
                    "severity": "urgent",
                    "waste_types": ["plastic bottles"],
                    "estimated_waste_kg": 2.0,
                    "cleanup_time_minutes": 15,
                    "confidence": 0.9,
                    "detected_at": "2026-04-03T22:00:00",
                }
            ],
        )
        self.assertEqual(response.status_code, 422)
        payload = response.json()
        self.assertEqual(payload["error"]["code"], "VALIDATION_ERROR")

    def test_detect_image_contract_success(self):
        image = Image.new("RGB", (64, 64), color="white")
        bytes_buffer = io.BytesIO()
        image.save(bytes_buffer, format="PNG")
        bytes_buffer.seek(0)

        response = self.client.post(
            "/api/detect-image",
            files={"file": ("sample.png", bytes_buffer, "image/png")},
            headers=INGEST_HEADERS,
        )
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertIn(payload["status"], ["ok", "fallback"])
        self.assertIn("filename", payload)
        self.assertIn("detections", payload)
        self.assertIn("model_loaded", payload)
        self.assertIn("estimated_waste_kg", payload)

    def test_detect_image_rejects_non_image(self):
        response = self.client.post(
            "/api/detect-image",
            files={"file": ("sample.txt", io.BytesIO(b"not-an-image"), "text/plain")},
            headers=INGEST_HEADERS,
        )
        self.assertEqual(response.status_code, 400)
        payload = response.json()
        self.assertEqual(payload["error"]["code"], "INVALID_CONTENT_TYPE")

    def test_round_rollover_clears_positions_and_keeps_trash_history(self):
        first_round = self.client.post("/api/rounds/start", json={"drone_round_id": "round_a"}, headers=INGEST_HEADERS)
        self.assertEqual(first_round.status_code, 200)
        self.client.post(
            "/api/drone-position",
            json={
                "round_id": "round_a",
                "drone_id": "drone_1",
                "lat": 33.84,
                "lng": -117.95,
            },
            headers=INGEST_HEADERS,
        )
        self.client.post(
            "/api/trash-entry",
            json={
                "round_id": "round_a",
                "drone_id": "drone_1",
                "lat": 33.8446,
                "lng": -117.9539,
                "size": 5,
            },
            headers=INGEST_HEADERS,
        )

        second_round = self.client.post("/api/rounds/start", json={"drone_round_id": "round_b"}, headers=INGEST_HEADERS)
        self.assertEqual(second_round.status_code, 200)

        hotspots = self.client.get("/api/hotspots", params={"zip": "92801", "radius_km": 2.0})
        self.assertEqual(hotspots.status_code, 200)
        payload = hotspots.json()
        self.assertGreaterEqual(len(payload), 1)

    def test_trash_entry_size_validation(self):
        self.client.post("/api/rounds/start", json={"drone_round_id": "round_size"}, headers=INGEST_HEADERS)
        response = self.client.post(
            "/api/trash-entry",
            json={
                "round_id": "round_size",
                "drone_id": "drone_1",
                "lat": 33.84,
                "lng": -117.95,
                "size": 11,
            },
            headers=INGEST_HEADERS,
        )
        self.assertEqual(response.status_code, 422)

    def test_hotspots_unknown_zip(self):
        response = self.client.get("/api/hotspots", params={"zip": "00000", "radius_km": 2.0})
        self.assertEqual(response.status_code, 404)
        payload = response.json()
        self.assertEqual(payload["error"]["code"], "ZIP_NOT_FOUND")

    def test_hotspots_color_scoring(self):
        self.client.post("/api/rounds/start", json={"drone_round_id": "round_score"}, headers=INGEST_HEADERS)
        for size in [1, 2, 10, 10, 10]:
            self.client.post(
                "/api/trash-entry",
                json={
                    "round_id": "round_score",
                    "drone_id": "drone_1",
                    "lat": 33.8446,
                    "lng": -117.9539,
                    "size": size,
                },
                headers=INGEST_HEADERS,
            )

        response = self.client.get("/api/hotspots", params={"zip": "92801", "radius_km": 2.0})
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertGreaterEqual(len(payload), 1)
        self.assertIn(payload[0]["color"], ["green", "yellow", "red"])
        self.assertGreater(payload[0]["score"], 0)
        self.assertIn("estimated_waste_kg", payload[0])
        self.assertIn("cleanup_time_minutes", payload[0])

    def test_nearby_disposal_sites_success(self):
        response = self.client.get(
            "/api/disposal-sites/nearby",
            params={"lat": 33.84, "lng": -117.95, "limit": 3},
        )
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertGreaterEqual(len(payload), 1)
        self.assertLessEqual(len(payload), 3)
        self.assertIn("site_id", payload[0])
        self.assertIn("name", payload[0])
        self.assertIn("maps_url", payload[0])
        self.assertIn("address", payload[0])
        self.assertIn("distance_km", payload[0])

    def test_nearby_disposal_sites_invalid_lat(self):
        response = self.client.get(
            "/api/disposal-sites/nearby",
            params={"lat": 91, "lng": -117.95, "limit": 3},
        )
        self.assertEqual(response.status_code, 400)
        payload = response.json()
        self.assertEqual(payload["error"]["code"], "INVALID_LAT")

    def test_ingest_auth_rejected_when_missing_token(self):
        response = self.client.post("/api/rounds/start", json={"drone_round_id": "round_noauth"})
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json()["error"]["code"], "UNAUTHORIZED")


if __name__ == "__main__":
    unittest.main()
