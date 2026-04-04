import io
import unittest

from fastapi.testclient import TestClient
from PIL import Image

from backend.main import app

class CleanSkyApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app)

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
        )
        self.assertEqual(response.status_code, 400)
        payload = response.json()
        self.assertEqual(payload["error"]["code"], "INVALID_CONTENT_TYPE")


if __name__ == "__main__":
    unittest.main()
