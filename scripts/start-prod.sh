#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [ ! -d ".venv" ]; then
  python3 -m venv .venv
fi

source .venv/bin/activate
pip install -r requirements.txt >/dev/null
npm install >/dev/null
npm run build >/dev/null

cleanup() {
  if [[ -n "${BACKEND_PID:-}" ]]; then kill "$BACKEND_PID" 2>/dev/null || true; fi
  if [[ -n "${FRONTEND_PID:-}" ]]; then kill "$FRONTEND_PID" 2>/dev/null || true; fi
}
trap cleanup EXIT INT TERM

uvicorn backend.main:app --host 0.0.0.0 --port 8000 &
BACKEND_PID=$!

npm run preview -- --host 0.0.0.0 --port 4173 &
FRONTEND_PID=$!

wait "$BACKEND_PID" "$FRONTEND_PID"
