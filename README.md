# Solar Potential Mapper MVP

A demo-first web app that estimates additional rooftop solar capacity for a pilot city and visualizes the best candidate rooftops on an interactive map.

## What it includes

- React + Vite frontend dashboard
- Local Node API with seeded pilot data for Coral Gables, Florida
- Building-level solar estimates, confidence, and explainable opportunity scores
- Ranked rooftop list and detail panel
- Google Maps support when a key is available
- Built-in fallback map preview so the demo still works without a key

## Run locally

Install dependencies if needed:

```bash
npm install
```

Start the API in one terminal:

```bash
npm run api
```

Start the frontend in a second terminal:

```bash
npm run dev
```

The Vite app proxies `/api/*` requests to `http://localhost:8787`.

## Optional Google Maps setup

Create a `.env` file and add:

```bash
VITE_GOOGLE_MAPS_API_KEY=your_google_maps_key
```

Without a key, the dashboard uses a built-in interactive fallback map so the rest of the product demo still works.

## API endpoints

- `GET /api/summary`
- `GET /api/buildings`
- `GET /api/buildings/:id`

## Checks

```bash
npm run lint
npm run build
```
