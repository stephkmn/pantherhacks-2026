#!/usr/bin/env python3
import json
import os
import sys
from urllib import request, error


def main() -> int:
    base_url = os.getenv("API_BASE_URL", "http://localhost:8000")
    ingest_api_key = os.getenv("INGEST_API_KEY", "dev-ingest-key")
    zip_code = os.getenv("SIM_ZIP_CODE", "92801")

    payload = {
        "zip_code": zip_code,
        "drone_count": int(os.getenv("SIM_DRONE_COUNT", "2")),
        "waypoints_per_drone": int(os.getenv("SIM_WAYPOINTS_PER_DRONE", "8")),
        "detections_per_drone": int(os.getenv("SIM_DETECTIONS_PER_DRONE", "2")),
        "seconds_between_waypoints": int(os.getenv("SIM_SECONDS_BETWEEN_WAYPOINTS", "4")),
    }
    body = json.dumps(payload).encode("utf-8")
    req = request.Request(
        f"{base_url}/api/simulate/fixed-route",
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "X-API-Key": ingest_api_key,
        },
    )

    try:
        with request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except error.HTTPError as exc:
        detail = exc.read().decode("utf-8")
        print(f"Simulation request failed ({exc.code}): {detail}", file=sys.stderr)
        return 1
    except error.URLError as exc:
        print(f"Simulation request failed: {exc}", file=sys.stderr)
        return 1

    print(f"round_id: {data['round_id']}")
    print(f"zip_code: {data['zip_code']}")
    print(f"drones: {', '.join(data['drone_ids'])}")
    print(f"positions: {data['total_positions']}")
    print(f"detections: {data['total_detections']}")
    print(f"foxglove_messages: {len(data['foxglove_messages'])}")
    if data.get("warnings"):
        print("warnings:")
        for warning in data["warnings"]:
            print(f"- {warning}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
