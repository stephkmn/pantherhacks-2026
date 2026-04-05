import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
// import { MapContainer, TileLayer, CircleMarker, Circle, Polyline, Popup, Tooltip, useMap } from 'react-leaflet';
import L from 'leaflet';
import { MapContainer, TileLayer, CircleMarker, Circle, Polyline, Popup, Tooltip, Marker, useMap } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
// ── Mock data ─────────────────────────────────────────────────────────────────
const PLACEHOLDER_PHOTO = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='360' height='220'><rect width='100%25' height='100%25' fill='%231f2937'/><text x='50%25' y='46%25' fill='%23e5e7eb' font-size='18' text-anchor='middle' font-family='Arial'>Garbage Photo</text><text x='50%25' y='58%25' fill='%239ca3af' font-size='13' text-anchor='middle' font-family='Arial'>Placeholder</text></svg>";

function buildStreetViewUrl(lat, lng) {
  const params = new URLSearchParams({
    size: '640x360',
    location: `${lat},${lng}`,
    fov: '90',
    heading: '0',
    pitch: '0',
  });
  const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;
  if (apiKey) {
    params.set('key', apiKey);
  }
  return `https://maps.googleapis.com/maps/api/streetview?${params.toString()}`;
}

function buildStaticMapUrl(lat, lng) {
  const params = new URLSearchParams({
    center: `${lat},${lng}`,
    zoom: '16',
    size: '640x360',
    markers: `${lat},${lng},red-pushpin`,
  });
  return `https://staticmap.openstreetmap.de/staticmap.php?${params.toString()}`;
}

function HotspotImage({ hotspot, alt, className, style }) {
  const sources = [hotspot.photo, hotspot.map_preview, PLACEHOLDER_PHOTO].filter(Boolean);
  const [sourceIdx, setSourceIdx] = useState(0);

  useEffect(() => {
    setSourceIdx(0);
  }, [hotspot.id, hotspot.photo, hotspot.map_preview]);

  return (
    <img
      src={sources[Math.min(sourceIdx, sources.length - 1)]}
      alt={alt}
      className={className}
      style={style}
      onError={() => setSourceIdx((prev) => Math.min(prev + 1, sources.length - 1))}
    />
  );
}

const KG_TO_LB = 2.2046226218;
const KM_TO_MI = 0.621371;
const formatLbs = (valueKg) => (Number(valueKg || 0) * KG_TO_LB).toFixed(2);
const formatMiles = (valueKm) => (Number(valueKm || 0) * KM_TO_MI).toFixed(2);
const formatMinutes = (value) => Math.round(Number(value || 0));
const buildDefaultRoundId = () => `phone_demo_${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;
// ── Nearest-neighbor route builder ───────────────────────────────────────────
// Haversine distance in km between two [lat,lng] points
function haversine([lat1, lng1], [lat2, lng2]) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Greedy nearest-neighbor TSP starting from the first hotspot in the list
function buildNearestNeighborRoute(hotspots) {
  if (!hotspots.length) return { ordered: [], route_coordinates: [], total_distance_km: 0 };

  const unvisited = [...hotspots];

  // Start from the hotspot closest to the centroid so the path flows naturally by geography
  const centLat = unvisited.reduce((s, h) => s + h.lat, 0) / unvisited.length;
  const centLng = unvisited.reduce((s, h) => s + h.lng, 0) / unvisited.length;
  let startIdx = 0, startDist = Infinity;
  unvisited.forEach((h, i) => {
    const d = haversine([centLat, centLng], [h.lat, h.lng]);
    if (d < startDist) { startDist = d; startIdx = i; }
  });
  const ordered = [unvisited.splice(startIdx, 1)[0]];

  while (unvisited.length) {
    const last = ordered[ordered.length - 1];
    let bestIdx = 0;
    let bestDist = Infinity;
    unvisited.forEach((h, i) => {
      const d = haversine([last.lat, last.lng], [h.lat, h.lng]);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    });
    ordered.push(unvisited.splice(bestIdx, 1)[0]);
  }

  // Sum up total distance along the ordered path
  let totalDist = 0;
  for (let i = 1; i < ordered.length; i++) {
    totalDist += haversine(
      [ordered[i - 1].lat, ordered[i - 1].lng],
      [ordered[i].lat, ordered[i].lng]
    );
  }

  return {
    ordered,
    route_coordinates: ordered.map(h => [h.lat, h.lng]),
    total_distance_km: +totalDist.toFixed(2),
    total_time_minutes: Math.round(ordered.reduce((s, h) => s + h.cleanup_time_minutes, 0)),
    total_waste_kg: Number(ordered.reduce((s, h) => s + h.estimated_waste_kg, 0).toFixed(2)),
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const SEV_COLOR = { high: '#ff3b3b', medium: '#ffaa00', low: '#22c55e' };
const SEV_RADIUS = { high: 220, medium: 160, low: 100 };
const getSeverityColor = (s) => SEV_COLOR[s] || '#3b82f6';
const colorToSeverity = (color) => {
  if (color === 'red') return 'high';
  if (color === 'yellow') return 'medium';
  return 'low';
};

// Recenter map when zip changes
function MapRecenter({ center }) {
  const map = useMap();
  useEffect(() => { map.setView(center, 14, { animate: true }); }, [center]);
  return null;
}

// ── Drone animation overlay (canvas) ─────────────────────────────────────────
// function DroneCanvas({ active }) {
//   const canvasRef = useRef(null);
//   const animRef = useRef(null);

//   useEffect(() => {
//     if (!active) return;
//     const canvas = canvasRef.current;
//     if (!canvas) return;
//     const ctx = canvas.getContext('2d');
//     let t = 0;

//     const draw = () => {
//       ctx.clearRect(0, 0, canvas.width, canvas.height);
//       // Drone path sweep lines
//       ctx.strokeStyle = 'rgba(0,230,255,0.18)';
//       ctx.lineWidth = 1;
//       for (let i = 0; i < 8; i++) {
//         const y = ((t * 0.4 + i * 40) % canvas.height);
//         ctx.beginPath();
//         ctx.moveTo(0, y);
//         ctx.lineTo(canvas.width, y);
//         ctx.stroke();
//       }
//       // Drone dot
//       const dx = 60 + (Math.sin(t * 0.02) * 0.5 + 0.5) * (canvas.width - 120);
//       const dy = 60 + (Math.sin(t * 0.013 + 1) * 0.5 + 0.5) * (canvas.height - 120);
//       ctx.beginPath();
//       ctx.arc(dx, dy, 7, 0, Math.PI * 2);
//       ctx.fillStyle = 'rgba(0,230,255,0.9)';
//       ctx.fill();
//       // Pulse ring
//       ctx.beginPath();
//       ctx.arc(dx, dy, 7 + (t % 40) * 0.6, 0, Math.PI * 2);
//       ctx.strokeStyle = `rgba(0,230,255,${0.6 - (t % 40) * 0.015})`;
//       ctx.lineWidth = 1.5;
//       ctx.stroke();
//       t++;
//       animRef.current = requestAnimationFrame(draw);
//     };
//     animRef.current = requestAnimationFrame(draw);
//     return () => cancelAnimationFrame(animRef.current);
//   }, [active]);

//   if (!active) return null;
//   return (
//     <canvas
//       ref={canvasRef}
//       width={800} height={600}
//       style={{
//         position: 'absolute', inset: 0, width: '100%', height: '100%',
//         pointerEvents: 'none', zIndex: 500, opacity: 0.7,
//       }}
//     />
//   );
// }
function DroneOverlay({ active }) {
  const [pos, setPos] = useState({ x: -100, y: -100 });
  const mapWrapRef = useRef(null);
  const timeoutsRef = useRef([]);

  useEffect(() => {
    timeoutsRef.current.forEach(clearTimeout);
    timeoutsRef.current = [];

    if (!active) return;

    const fly = () => {
      const el = mapWrapRef.current?.parentElement;
      const W = el?.offsetWidth || 900;
      const H = el?.offsetHeight || 600;

      const x = 60 + Math.random() * (W - 120);
      const y = 60 + Math.random() * (H - 120);

      setPos({ x, y });

      const id = setTimeout(fly, 900 + Math.random() * 600);
      timeoutsRef.current.push(id);
    };

    fly();
    return () => timeoutsRef.current.forEach(clearTimeout);
  }, [active]);

  if (!active) return null;

  return (
    <div
      ref={mapWrapRef}
      style={{
        position: 'absolute',
        left: pos.x,
        top: pos.y,
        transform: 'translate(-50%, -50%)',
        zIndex: 1000,
        pointerEvents: 'none',
        transition: 'left 0.8s cubic-bezier(0.45,0,0.55,1), top 0.8s cubic-bezier(0.45,0,0.55,1)',
        filter: 'drop-shadow(0 0 14px rgba(0,229,255,0.8))',
      }}
    >
      <img src="/drone.png" alt="" width={72} />
    </div>
  );
}
// ── TITLE PAGE ────────────────────────────────────────────────────────────────
function TitlePage({ onEnter }) {
  const [visible, setVisible] = useState(false);
  const [dronePos, setDronePos] = useState({ x: -10, y: 20, rot: -15 });

  useEffect(() => { setTimeout(() => setVisible(true), 100); }, []);

  useEffect(() => {
    const waypoints = [
      { x: -12, y: 18, rot: -10 },
      { x: 30,  y: 8,  rot: 5   },
      { x: 65,  y: 22, rot: -8  },
      { x: 90,  y: 10, rot: 12  },
      { x: 108, y: 30, rot: -5  },
      { x: 75,  y: 55, rot: 15  },
      { x: 40,  y: 45, rot: -12 },
      { x: 10,  y: 60, rot: 8   },
      { x: -12, y: 40, rot: -15 },
    ];
    let idx = 0;
    let timeouts = [];
    const fly = () => {
      setDronePos(waypoints[idx % waypoints.length]);
      idx++;
      timeouts.push(setTimeout(fly, 1200));
    };
    timeouts.push(setTimeout(fly, 0));
    return () => timeouts.forEach(clearTimeout);
  }, []);

  return (
    <div className={`title-page ${visible ? 'visible' : ''}`}>
      <div className="title-bg" />
      <div className="title-noise" />

      <div
        className="drone-fly"
        style={{ left: `${dronePos.x}vw`, top: `${dronePos.y}vh`, transform: `rotate(${dronePos.rot}deg)` }}
       >
        <img src="/drone.png" alt="drone" width="120" />
      
        {/* 🛸
        <div className="drone-fly-ring r1" />
        <div className="drone-fly-ring r2" /> */}
      </div>

      <div className="title-content">
  <h1 className="title-logo">
    <span className="title-sky">Sky</span>
    <span className="title-sweep">Sweep</span>
  </h1>
  <div className="title-eyebrow">DRONE-POWERED WASTE DETECTION</div>
  <button className="title-cta" onClick={onEnter}>Get Started</button>
</div>
    </div>
  );
}
// ── PHOTO MODAL ───────────────────────────────────────────────────────────────
function PhotoModal({ hotspot, onClose, disposalSites, disposalLoading, disposalError }) {
  if (!hotspot) return null;
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={e => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}>✕</button>
        <div className="modal-severity" style={{ background: getSeverityColor(hotspot.severity) }}>
          {hotspot.severity.toUpperCase()} PRIORITY
        </div>
        <HotspotImage hotspot={hotspot} alt="Trash site" className="modal-photo" />
        <div className="modal-info">
          <h3>{hotspot.name}</h3>
          <div className="modal-stats">
            <div className="modal-stat">
              <span className="mstat-label">Waste Est.</span>
              <span className="mstat-value">{formatLbs(hotspot.estimated_waste_kg)} lb</span>
            </div>
            <div className="modal-stat">
              <span className="mstat-label">Cleanup</span>
              <span className="mstat-value">{formatMinutes(hotspot.cleanup_time_minutes)} min</span>
            </div>
          </div>
          <div className="modal-types">
            {hotspot.waste_types.map(t => (
              <span key={t} className="waste-tag">{t}</span>
            ))}
          </div>
          <div className={`crew-rec ${hotspot.severity === 'high' ? 'crew-needed' : ''}`}>
            {hotspot.severity === 'high'
              ? 'Crew deployment recommended for this site'
              : 'Single operator sufficient'}
          </div>
          <div className="modal-disposal">
            <div className="modal-disposal-title">Nearby Disposal Sites</div>
            {disposalLoading && <div className="modal-disposal-empty">Loading suggestions...</div>}
            {!disposalLoading && disposalError && (
              <div className="modal-disposal-empty">{disposalError}</div>
            )}
            {!disposalLoading && !disposalError && disposalSites.length === 0 && (
              <div className="modal-disposal-empty">No nearby disposal sites found.</div>
            )}
            {!disposalLoading && !disposalError && disposalSites.length > 0 && (
              <div className="modal-disposal-list">
                {disposalSites.map((site) => (
                  <a
                    key={site.site_id}
                    className="modal-disposal-item"
                    href={site.maps_url || `https://www.google.com/maps/search/?api=1&query=${site.lat},${site.lng}`}
                    target="_blank"
                    rel="noreferrer"
                    title="Open in Google Maps"
                  >
                    <div className="modal-disposal-name">{site.name}</div>
                    <div className="modal-disposal-meta">
                      {site.site_type.replace(/_/g, ' ')} · {formatMiles(site.distance_km)} mi · {site.hours}
                    </div>
                    {site.address && <div className="modal-disposal-meta">{site.address}</div>}
                  </a>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Build route from a starting [lat,lng] through active hotspots ─────────────
function buildRouteFromStart(startLatLng, hotspots) {
  if (!hotspots.length) return { ordered: [], route_coordinates: [], total_distance_km: 0, total_time_minutes: 0, total_waste_kg: 0 };
  const unvisited = [...hotspots];
  const ordered = [];
  let current = startLatLng;
  while (unvisited.length) {
    let bestIdx = 0, bestDist = Infinity;
    unvisited.forEach((h, i) => {
      const d = haversine(current, [h.lat, h.lng]);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    });
    const next = unvisited.splice(bestIdx, 1)[0];
    ordered.push(next);
    current = [next.lat, next.lng];
  }
  let totalDist = haversine(startLatLng, [ordered[0].lat, ordered[0].lng]);
  for (let i = 1; i < ordered.length; i++)
    totalDist += haversine([ordered[i-1].lat, ordered[i-1].lng], [ordered[i].lat, ordered[i].lng]);
  return {
    ordered,
    route_coordinates: [startLatLng, ...ordered.map(h => [h.lat, h.lng])],
    total_distance_km: +totalDist.toFixed(2),
    total_time_minutes: Math.round(ordered.reduce((s, h) => s + h.cleanup_time_minutes, 0)),
    total_waste_kg: Number(ordered.reduce((s, h) => s + h.estimated_waste_kg, 0).toFixed(2)),
  };
}

// ── Map click handler ─────────────────────────────────────────────────────────
function MapClickHandler({ enabled, onMapClick, onMapBackgroundClick }) {
  const map = useMap();
  useEffect(() => {
    const clickHandler = (e) => {
      if (enabled) {
        onMapClick([e.latlng.lat, e.latlng.lng]);
      } else {
        onMapBackgroundClick();
      }
    };
    map.on('click', clickHandler);
    return () => map.off('click', clickHandler);
  }, [enabled, onMapClick, onMapBackgroundClick]);
  return null;
}

// ── DASHBOARD PAGE ────────────────────────────────────────────────────────────
function Dashboard() {
  
  const [hoverInfo, setHoverInfo] = useState(null); // { h, x, y }
  const [zip, setZip] = useState('');
  const [scanning, setScanning] = useState(false);
  const [scanDone, setScanDone] = useState(false);
  const [allHotspots, setAllHotspots] = useState([]);   // all detected, never mutated
  const [skipped, setSkipped] = useState(new Set());    // skipped hotspot ids
  const [startPin, setStartPin] = useState(null);       // [lat, lng] user clicked
  const [pickingStart, setPickingStart] = useState(false);
  const [route, setRoute] = useState(null);
  const [mapCenter, setMapCenter] = useState([33.8366, -117.9143]);
  const [selectedHotspot, setSelectedHotspot] = useState(null);
  const [nearbyDisposalSites, setNearbyDisposalSites] = useState([]);
  const [nearbyDisposalLoading, setNearbyDisposalLoading] = useState(false);
  const [nearbyDisposalError, setNearbyDisposalError] = useState('');
  const [activeFilter, setActiveFilter] = useState('all');
  const [scanError, setScanError] = useState('');
  const [prefetchedRoute, setPrefetchedRoute] = useState(null);
  const [selectedZone, setSelectedZone] = useState(null);
const sidebarRef = useRef(null);
const cardRefs = useRef({});

  useEffect(() => {
    if (!selectedHotspot) {
      setNearbyDisposalSites([]);
      setNearbyDisposalLoading(false);
      setNearbyDisposalError('');
      return;
    }

    let cancelled = false;
    const fetchNearbyDisposalSites = async () => {
      setNearbyDisposalLoading(true);
      setNearbyDisposalError('');
      try {
        const response = await axios.get('/api/disposal-sites/nearby', {
          params: {
            lat: selectedHotspot.lat,
            lng: selectedHotspot.lng,
            limit: 3,
          },
        });
        if (!cancelled) {
          setNearbyDisposalSites(response.data || []);
        }
      } catch (error) {
        if (!cancelled) {
          setNearbyDisposalSites([]);
          const apiError = error?.response?.data?.error;
          setNearbyDisposalError(apiError?.message || 'Unable to load disposal site suggestions.');
        }
      } finally {
        if (!cancelled) {
          setNearbyDisposalLoading(false);
        }
      }
    };

    fetchNearbyDisposalSites();
    return () => {
      cancelled = true;
    };
  }, [selectedHotspot]);

  // Active hotspots = all minus skipped
  const activeHotspots = allHotspots.filter(h => !skipped.has(h.id));
  const filteredActive = activeFilter === 'all'
  ? activeHotspots
  : activeHotspots.filter(h => h.severity === activeFilter);

  // Recompute route whenever start pin or active hotspots change
  // useEffect(() => {
  //   if (!startPin || !activeHotspots.length) { setRoute(null); return; }
  //   setRoute(buildRouteFromStart(startPin, activeHotspots));
  // }, [startPin, skipped, allHotspots]);

  useEffect(() => {
  if (!startPin || !filteredActive.length) { setRoute(null); return; }
  setRoute(buildRouteFromStart(startPin, filteredActive));
}, [startPin, skipped, allHotspots, activeFilter]);

  const runScan = async () => {
    if (!zip || zip.length < 5) return;
    setScanning(true);
    setScanError('');
    setScanDone(false);
    setAllHotspots([]);
    setSkipped(new Set());
    setStartPin(null);
    setRoute(null);
    setPrefetchedRoute(null);
    const MIN_SCAN_MS = 4000; // minimum time the "scanning" state shows
    const startTime = Date.now();

    try {
      const hotspotsResponse = await axios.get('/api/hotspots', {
        params: { zip, radius_km: 2.0 },
      });
       const elapsed = Date.now() - startTime;
    if (elapsed < MIN_SCAN_MS) {
      await new Promise(res => setTimeout(res, MIN_SCAN_MS - elapsed));
    }

      const scanned = (hotspotsResponse.data || []).map((hotspot, idx) => ({
        id: hotspot.hotspot_id,
        lat: hotspot.lat,
        lng: hotspot.lng,
        severity: colorToSeverity(hotspot.color),
        name: `Zone #${idx + 1}`,
        estimated_waste_kg: Number(hotspot.estimated_waste_kg || 0),
        cleanup_time_minutes: Number(hotspot.cleanup_time_minutes || 0),
        waste_types: [],
        // waste_types: [
        //   `${hotspot.pile_count} pile${hotspot.pile_count === 1 ? '' : 's'}`,
        //   `Avg size ${hotspot.avg_size}/10`,
        //   `Score ${hotspot.score}`,
        // ],
        detected_at: hotspot.last_detected_at,
        photo: buildStreetViewUrl(hotspot.lat, hotspot.lng),
        map_preview: buildStaticMapUrl(hotspot.lat, hotspot.lng),
      }));
      //setAllHotspots(scanned);
      setAllHotspots([]);
scanned.forEach((hotspot, i) => {
  setTimeout(() => {
    setAllHotspots(prev => [...prev, hotspot]);
  }, i * 80);
});
      

      if (scanned.length > 0) {
        const centerLat = scanned.reduce((sum, h) => sum + h.lat, 0) / scanned.length;
        const centerLng = scanned.reduce((sum, h) => sum + h.lng, 0) / scanned.length;
        setMapCenter([centerLat, centerLng]);
        setPrefetchedRoute(buildNearestNeighborRoute(scanned));
      }

      setScanning(false);
      setScanDone(true);
    } catch (error) {
      setScanning(false);
      setScanDone(false);
      setAllHotspots([]);
      setPrefetchedRoute(null);
      const apiError = error?.response?.data?.error;
      if (apiError?.code === 'ZIP_NOT_FOUND') {
        setScanError(`${apiError.message} Try an Orange County ZIP like 92801, 92802, 92804, 92704, or 92683.`);
      } else {
        setScanError(apiError?.message || 'Unable to fetch hotspots. Confirm backend is running and ZIP is seeded.');
      }
    }
  };

  const toggleSkip = (id, e) => {
    e.stopPropagation();
    setSkipped(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const handleMapClick = (latlng) => {
    setStartPin(latlng);
    setPickingStart(false);
  };

  const filtered = activeFilter === 'all'
    ? allHotspots
    : allHotspots.filter(h => h.severity === activeFilter);

  const displayRoute = route;
  const routeStops = route ? route.ordered : [];

  return (
    <div className="dashboard">
      {/* Top bar */}
      <header className="dash-header">
        <div className="dash-logo">
          <span className="dash-sky">Sky</span><span className="dash-sweep">Sweep</span>
        </div>
      </header>

      {/* Zip input bar */}
      <div className="zip-bar">
  <div className="zip-top-row">
    <div className="zip-inner">
      <div className="zip-label">Enter ZIP Code to Scan</div>
      <div className="zip-row">
        <input
          className="zip-input"
          type="text"
          placeholder="e.g. 92801"
          maxLength={5}
          value={zip}
          onChange={e => setZip(e.target.value.replace(/\D/, ''))}
          onKeyDown={e => e.key === 'Enter' && runScan()}
        />
        <button
          className={`zip-btn ${scanning ? 'scanning' : ''}`}
          onClick={runScan}
          disabled={scanning || zip.length < 5}
        >
          {scanning ? <><span className="spin" /> Scanning...</> : 'Run Scan'}
        </button>
      </div>
      {scanError && <div style={{ marginTop: 10, color: '#ff6b6b', fontSize: 13 }}>{scanError}</div>}
      {scanning && (
        <div className="scan-progress">
          <div className="scan-bar"><div className="scan-fill" /></div>
          <span>Flying drone over ZIP Code {zip}</span>
        </div>
      )}
      {scanDone && allHotspots.length > 0 && (
        <div className="start-picker-bar">
          {!startPin ? (
            <>
             <span className="start-hint">
  {pickingStart
    ? 'Click a dot on the map as your starting location to generate a cleanup route throughout the area'
    : 'Click a location on the map to generate a cleanup route'}
</span>
              <button className={`pick-btn ${pickingStart ? 'picking' : ''}`} onClick={() => setPickingStart(p => !p)}>
                {pickingStart ? '✕ Cancel' : 'Pick Start'}
              </button>
            </>
          ) : (
            <>
              <span className="start-hint start-set">
                The route covers {filteredActive.length} stop{filteredActive.length !== 1 ? 's' : ''}
                {skipped.size > 0 && <span className="skipped-badge">{skipped.size} skipped</span>}
              </span>
              <button className="pick-btn" onClick={() => { setStartPin(null); setRoute(null); }}>Reset</button>
            </>
          )}
        </div>
      )}
    </div>

    {/* Stats inline top right */}
    {scanDone && (
      <div className="top-stats">
        <div className="stat-box">
          <div className="stat-num">{filteredActive.length}</div>
          <div className="stat-lbl">Active Stops</div>
        </div>
        <div className="stat-box">
          <div className="stat-num">{formatLbs(filteredActive.reduce((s,h)=>s+h.estimated_waste_kg,0))}<small>lb</small></div>
          <div className="stat-lbl">Est. Waste</div>
        </div>
        <div className="stat-box">
          <div className="stat-num">{formatMinutes(filteredActive.reduce((s,h)=>s+h.cleanup_time_minutes,0))}<small>m</small></div>
          <div className="stat-lbl">Cleanup Time</div>
        </div>
        {displayRoute && (
          <div className="stat-box">
            <div className="stat-num">{formatMiles(displayRoute.total_distance_km)}<small>mi</small></div>
            <div className="stat-lbl">Route Dist.</div>
          </div>
        )}
      </div>
    )}
  </div>
</div>

      {/* Main layout */}
      <div className="dash-grid">
        {/* Map */}
        <div className={`map-wrap ${pickingStart ? 'cursor-crosshair' : ''}`}>
          <DroneOverlay active={scanning} /> {}
          <MapContainer center={mapCenter} zoom={14} style={{ height: '100%', width: '100%' }}>
            <MapRecenter center={mapCenter} />
            <TileLayer
              url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
              attribution='&copy; CartoDB'
            />
            <MapClickHandler
  enabled={pickingStart}
  onMapClick={handleMapClick}
  onMapBackgroundClick={() => setSelectedZone(null)}
/>

            {/* Hotspot markers */}
           {filtered.map((h, i) => {
  const isSkipped = skipped.has(h.id);
  // const routeIdx = routeStops.findIndex(r => r.id === h.id);
  // const stopNum = routeIdx >= 0 ? routeIdx + 1 : i + 1;
  const stopNum = i + 1;
  const color = isSkipped ? '#444' : getSeverityColor(h.severity);

  const icon = L.divIcon({
    className: '',
    html: `<div style="
      width:28px;height:28px;border-radius:50%;
      background:${color};border:2px solid white;
      display:flex;align-items:center;justify-content:center;
      font-weight:700;font-size:12px;color:white;
      cursor:pointer;
    ">${stopNum}</div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });

  return (
    <React.Fragment key={h.id}>
      <Marker
        position={[h.lat, h.lng]}
        icon={icon}
        eventHandlers={{
 click: (e) => {
  if (pickingStart) {
    handleMapClick([e.latlng.lat, e.latlng.lng]);
  } else if (!isSkipped) {
    console.log('clicked id:', h.id, typeof h.id);
    setSelectedZone(h.id);
    setTimeout(() => {
      cardRefs.current[h.id]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 50);
  }
},
  mouseover: (e) => {
    if (!pickingStart) {
      const { x, y } = e.containerPoint;
      setHoverInfo({ h, stopNum, x, y });
    }
  },
  mouseout: () => setHoverInfo(null),
}}
      />
      {!isSkipped && (
        <Circle
          center={[h.lat, h.lng]}
          radius={SEV_RADIUS[h.severity]}
          fillColor={color}
          color={color}
          weight={1} opacity={0.4} fillOpacity={0.12}
        />
      )}
    </React.Fragment>
  );
})}
{displayRoute && displayRoute.route_coordinates && displayRoute.route_coordinates.length > 1 && (
              <Polyline
                positions={displayRoute.route_coordinates}
                color="#00e5ff" weight={3} opacity={0.85} dashArray="8,5"
              />
            )}
          {startPin && (
  <Marker
    position={startPin}
    icon={L.divIcon({
      className: '',
      html: `<div style="
        width:28px;height:28px;border-radius:50%;
        background:#1bb7bf;border:2px solid white;
        display:flex;align-items:center;justify-content:center;
        font-weight:700;font-size:8px;color:#060b14;
        box-shadow: 0 0 12px rgba(10,119,131,0.8);
      "></div>`,
      iconSize: [28, 28],
      iconAnchor: [14, 14],
    })}
  />
)}
            {/* <DroneCanvas active={scanning} /> */}
            {/* <DroneOverlay active={scanning} /> */}
          </MapContainer>
          {scanDone && !startPin && !scanning && !pickingStart && allHotspots.length > 0 && (
  <div className="map-instruction">
    <div className="map-instruction-inner">
      Click the <strong>Pick Start</strong> button above to start planning your route
    </div>
  </div>
)}
          {hoverInfo && (
 <div className="map-hover-card" style={{ left: hoverInfo.x + 16, top: hoverInfo.y - 10 }}>
  <strong>Zone #{hoverInfo.stopNum}</strong>
  <div style={{ color: getSeverityColor(hoverInfo.h.severity), fontSize: 11, marginTop: 3 }}>
    ● {hoverInfo.h.severity.toUpperCase()} · {formatLbs(hoverInfo.h.estimated_waste_kg)}lb · {formatMinutes(hoverInfo.h.cleanup_time_minutes)}min
  </div>
  {/* <div style={{ fontSize: 11, color: '#aaa', marginTop: 3 }}>Click to view photo</div> */}
</div>
)}

          {/* Crosshair overlay when picking */}
          {/* {pickingStart && (
            <div className="crosshair-overlay">
              <div className="crosshair-msg">Click to drop your start pin</div>
            </div>
          )} */}

          {!scanDone && !scanning && (
            <div className="map-idle">
              {/* <div className="map-idle-icon">🛸</div> */}
              {/* <div>Enter a ZIP code above to deploy drone scan</div> */}
            </div>
          )}
          {scanDone && !scanning && allHotspots.length === 0 && (
            <div className="map-idle">
              <div className="map-idle-icon"></div>
              <div>No zones detected for this scan.</div>
            </div>
          )}
        </div>

        {/* Sidebar */}
        <div className="sidebar" ref={sidebarRef}>
          
        
          {/* Filter tabs */}
          {scanDone && (
            <div className="filter-tabs">
              {['all', 'high', 'medium', 'low'].map(f => (
                <button key={f} className={`ftab ${activeFilter === f ? 'active' : ''} ftab-${f}`}
                  // onClick={() => setActiveFilter(f)}
                  onClick={() => { setActiveFilter(f); setStartPin(null); setRoute(null); }}>
                  {f === 'all' ? 'All' : f.charAt(0).toUpperCase() + f.slice(1)}
                </button>
              ))}
            </div>
          )}

          {/* Hotspot list */}
          {filtered.length > 0 && (
            <div className="hotspot-list-scroll">
              <div className="list-title">Detected Zones</div>
              {filtered.map((h, i) => {
                const isSkipped = skipped.has(h.id);
                return (
                  <div key={h.id}
  ref={el => cardRefs.current[h.id] = el}
  className={`hspot-card sev-${h.severity} ${isSkipped ? 'hspot-skipped' : ''} ${selectedZone === h.id ? 'hspot-selected' : ''}`}
  onClick={() => { if (!isSkipped) { setSelectedHotspot(h); setSelectedZone(null); } }}
>
                    <div className="hspot-top">
                      {/* <div className="hspot-rank">#{i + 1}</div> */}
                      <div className="hspot-name">{h.name}</div>
                      <div className="hspot-badge" style={{ background: isSkipped ? '#444' : getSeverityColor(h.severity) }}>
                        {isSkipped ? 'SKIPPED' : h.severity.toUpperCase()}
                      </div>
                    </div>
                    <div className="hspot-meta">
                      <span>Weight: {formatLbs(h.estimated_waste_kg)} lb</span>
                      <span>Time: {formatMinutes(h.cleanup_time_minutes)} min</span>
                    </div>
                    <div className="hspot-types">
                      {h.waste_types.map(t => <span key={t} className="wtype">{t}</span>)}
                    </div>
                    <div className="hspot-actions">
                      {!isSkipped && <div className="hspot-photo-hint">Click to view site photo</div>}
                      <button
                        className={`skip-btn ${isSkipped ? 'restore-btn' : ''}`}
                        onClick={(e) => toggleSkip(h.id, e)}
                      >
                        {isSkipped ? '↩ Restore' : '✕ Skip Stop'}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Route steps — only shown when start pin is set */}
          {/* {displayRoute && scanDone && routeStops.length > 0 && (
            <div className="route-panel">
              <div className="list-title">Your Cleanup Route</div>
              <div className="route-start-label">{startPin ? 'Your Start →' : 'Suggested Route'}</div>
              {routeStops.map((h, i) => (
                <div key={h.id} className="route-step-card">
                  <div className="rstep-num" style={{ background: getSeverityColor(h.severity) }}>{i + 1}</div>
                  <div style={{ flex: 1 }}>
                    <div className="rstep-name">{h.name}</div>
                    <div className="rstep-meta">{formatLbs(h.estimated_waste_kg)} lb · {formatMinutes(h.cleanup_time_minutes)} min</div>
                  </div>
                  <button className="rstep-skip" onClick={(e) => toggleSkip(h.id, e)} title="Skip this stop">✕</button>
                </div>
              ))}
              <div className="route-summary-pill">
                {formatMiles(displayRoute.total_distance_km)} mi · {formatMinutes(displayRoute.total_time_minutes)} min · {formatLbs(displayRoute.total_waste_kg)} lb total
              </div>
            </div>
          )} */}

          {/* No start pin yet but scan done */}
         

          {!scanDone && !scanning && (
            <div className="sidebar-empty">
              <div style={{ fontSize: 40 }}></div>
              <div>Scan results will appear here</div>
            </div>
          )}
          {scanning && (
            <div className="sidebar-empty">
              {/* <div className="big-spin">🛸</div> */}
              {/* <div>Drone scanning ZIP {zip}…</div> */}
              <div>Detecting trash zones nearby...</div>
              {/* <div style={{ fontSize: 12, opacity: 0.6, marginTop: 4 }}>Detecting trash zones nearby</div> */}
            </div>
          )}
          {scanDone && !scanning && allHotspots.length === 0 && (
            <div className="sidebar-empty">
              <div style={{ fontSize: 40 }}></div>
              <div>No hotspots found in this scan.</div>
            </div>
          )}
        </div>
      </div>

      <PhotoModal
        hotspot={selectedHotspot}
        onClose={() => setSelectedHotspot(null)}
        disposalSites={nearbyDisposalSites}
        disposalLoading={nearbyDisposalLoading}
        disposalError={nearbyDisposalError}
      />
    </div>
  );
}

function MobileDetectorDemo() {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const watchIdRef = useRef(null);
  const detectLoopRef = useRef(null);
  const detectInFlightRef = useRef(false);
  const latRef = useRef('');
  const lngRef = useRef('');
  const uploadCooldownRef = useRef(0);
  const [ingestKey, setIngestKey] = useState('');
  const [droneId, setDroneId] = useState('phone_demo');
  const [roundDraft, setRoundDraft] = useState(buildDefaultRoundId);
  const [roundId, setRoundId] = useState('');
  const [sessionError, setSessionError] = useState('');
  const [sessionStarting, setSessionStarting] = useState(false);
  const [lat, setLat] = useState('');
  const [lng, setLng] = useState('');
  const [locationLabel, setLocationLabel] = useState('Location not captured yet');
  const [locating, setLocating] = useState(false);
  const [liveMode, setLiveMode] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [detectError, setDetectError] = useState('');
  const [result, setResult] = useState(null);
  const [toastMessage, setToastMessage] = useState('');

  useEffect(() => {
    latRef.current = lat.trim();
    lngRef.current = lng.trim();
  }, [lat, lng]);

  useEffect(() => {
    if (!toastMessage) return undefined;
    const timeoutId = window.setTimeout(() => setToastMessage(''), 3200);
    return () => window.clearTimeout(timeoutId);
  }, [toastMessage]);

  useEffect(() => () => {
    if (detectLoopRef.current) {
      window.clearInterval(detectLoopRef.current);
    }
    if (watchIdRef.current !== null && navigator.geolocation) {
      navigator.geolocation.clearWatch(watchIdRef.current);
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
    }
  }, []);

  const captureLocation = async () => {
    if (!navigator.geolocation) {
      setLocationLabel('Geolocation is unavailable on this device');
      return null;
    }

    setLocating(true);
    setDetectError('');
    try {
      const position = await new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 10000,
          maximumAge: 30000,
        });
      });
      const nextLat = position.coords.latitude.toFixed(6);
      const nextLng = position.coords.longitude.toFixed(6);
      setLat(nextLat);
      setLng(nextLng);
      setLocationLabel(`Using live GPS: ${nextLat}, ${nextLng}`);
      return { lat: nextLat, lng: nextLng };
    } catch (error) {
      setLocationLabel('Location unavailable. Enter coordinates manually if phone GPS is blocked.');
      return null;
    } finally {
      setLocating(false);
    }
  };

  const beginLocationWatch = () => {
    if (!navigator.geolocation || watchIdRef.current !== null) {
      return;
    }

    watchIdRef.current = navigator.geolocation.watchPosition(
      (position) => {
        const nextLat = position.coords.latitude.toFixed(6);
        const nextLng = position.coords.longitude.toFixed(6);
        setLat(nextLat);
        setLng(nextLng);
        latRef.current = nextLat;
        lngRef.current = nextLng;
        setLocationLabel(`Live GPS locked: ${nextLat}, ${nextLng}`);
      },
      () => {
        setLocationLabel('Live GPS lost. Using the last known coordinates.');
      },
      {
        enableHighAccuracy: true,
        maximumAge: 5000,
        timeout: 10000,
      },
    );
  };

  const ensureSession = async () => {
    if (roundId) return roundId;
    if (!ingestKey.trim()) {
      throw new Error('Enter the ingest API key before starting the phone demo.');
    }

    setSessionStarting(true);
    setSessionError('');
    try {
      const response = await axios.post(
        '/api/rounds/start',
        { drone_round_id: roundDraft.trim() || buildDefaultRoundId() },
        { headers: { 'X-API-Key': ingestKey.trim() } },
      );
      setRoundId(response.data.id);
      return response.data.id;
    } catch (error) {
      const message = error?.response?.data?.error?.message || 'Unable to start a demo round.';
      setSessionError(message);
      throw new Error(message);
    } finally {
      setSessionStarting(false);
    }
  };

  const startCamera = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Camera access is unavailable in this browser.');
    }
    if (streamRef.current) {
      return streamRef.current;
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
      },
      audio: false,
    });
    streamRef.current = stream;
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
      await videoRef.current.play();
    }
    setCameraReady(true);
    return stream;
  };

  const stopLiveScan = () => {
    setLiveMode(false);
    setDetecting(false);
    setCameraReady(false);
    detectInFlightRef.current = false;

    if (detectLoopRef.current) {
      window.clearInterval(detectLoopRef.current);
      detectLoopRef.current = null;
    }

    if (watchIdRef.current !== null && navigator.geolocation) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  };

  const captureFrameAndDetect = async () => {
    if (detectInFlightRef.current || !videoRef.current || !canvasRef.current) {
      return;
    }

    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video.videoWidth || !video.videoHeight) {
      return;
    }

    let activeLat = latRef.current;
    let activeLng = lngRef.current;
    if (!activeLat || !activeLng) {
      const gps = await captureLocation();
      activeLat = gps?.lat || activeLat;
      activeLng = gps?.lng || activeLng;
    }
    if (!activeLat || !activeLng) {
      setDetectError('Location is required to upload trash entries. Enable GPS or enter coordinates manually.');
      return;
    }

    detectInFlightRef.current = true;
    setDetecting(true);
    setDetectError('');

    try {
      const activeRoundId = await ensureSession();

      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const context = canvas.getContext('2d');
      context.drawImage(video, 0, 0, canvas.width, canvas.height);

      const blob = await new Promise((resolve) => {
        canvas.toBlob(resolve, 'image/jpeg', 0.84);
      });
      if (!blob) {
        throw new Error('Unable to capture the current camera frame.');
      }

      const formData = new FormData();
      formData.append('file', blob, `live-detection-${Date.now()}.jpg`);
      formData.append('round_id', activeRoundId);
      formData.append('drone_id', droneId.trim());
      formData.append('lat', activeLat);
      formData.append('lng', activeLng);
      formData.append('detected_at', new Date().toISOString());

      const response = await axios.post('/api/detect-image', formData, {
        headers: {
          'X-API-Key': ingestKey.trim(),
        },
      });
      setResult(response.data);

      if (response.data.persisted_detection_count > 0) {
        const now = Date.now();
        if (now - uploadCooldownRef.current > 5000) {
          uploadCooldownRef.current = now;
          setToastMessage(
            `Uploaded ${response.data.persisted_detection_count} trash entr${response.data.persisted_detection_count === 1 ? 'y' : 'ies'} to the database.`,
          );
        }
      }
    } catch (error) {
      setDetectError(error?.response?.data?.error?.message || error.message || 'Detection failed.');
    } finally {
      detectInFlightRef.current = false;
      setDetecting(false);
    }
  };

  const startLiveScan = async () => {
    if (!droneId.trim()) {
      setDetectError('Set a device label so the trash entry has a source.');
      return;
    }

    setDetectError('');
    try {
      await ensureSession();
      await captureLocation();
      beginLocationWatch();
      await startCamera();
      setLiveMode(true);
      setToastMessage('Live trash detection started.');
      await captureFrameAndDetect();

      if (detectLoopRef.current) {
        window.clearInterval(detectLoopRef.current);
      }
      detectLoopRef.current = window.setInterval(() => {
        captureFrameAndDetect();
      }, 2500);
    } catch (error) {
      setDetectError(error?.message || 'Unable to start live detection.');
      stopLiveScan();
    }
  };

  return (
    <div className="mobile-demo">
      <div className="mobile-demo__hero">
        <div className="mobile-demo__eyebrow">Phone Trash Demo</div>
        <h1>Walk the building while the camera catches trash live.</h1>
        <p>
          Start the live feed, point the camera at litter, and each confirmed detection will upload a photo plus a trash entry.
        </p>
      </div>

      <div className="mobile-demo__panel">
        <div className="mobile-demo__grid">
          <label className="mobile-demo__field">
            <span>Ingest API Key</span>
            <input
              type="password"
              value={ingestKey}
              onChange={(event) => setIngestKey(event.target.value)}
              placeholder="dev-ingest-key"
              autoComplete="off"
            />
          </label>
          <label className="mobile-demo__field">
            <span>Device ID</span>
            <input value={droneId} onChange={(event) => setDroneId(event.target.value)} placeholder="phone_demo" />
          </label>
          <label className="mobile-demo__field">
            <span>Round ID</span>
            <input value={roundDraft} onChange={(event) => setRoundDraft(event.target.value)} placeholder="phone_demo_20260405" />
          </label>
          <button className="mobile-demo__button mobile-demo__button--secondary" onClick={ensureSession} disabled={sessionStarting}>
            {roundId ? 'Session Ready' : sessionStarting ? 'Starting...' : 'Start Session'}
          </button>
        </div>
        <div className="mobile-demo__session">
          <div>{roundId ? `Active round: ${roundId}` : 'No round started yet'}</div>
          <div>{locationLabel}</div>
          <div>{liveMode ? 'Live detection is running' : 'Live detection is stopped'}</div>
          {sessionError && <div className="mobile-demo__error">{sessionError}</div>}
        </div>
      </div>

      <div className="mobile-demo__panel">
        <div className="mobile-demo__actions">
          <button className="mobile-demo__button" onClick={liveMode ? stopLiveScan : startLiveScan}>
            {liveMode ? 'Stop Live Scan' : 'Start Live Scan'}
          </button>
          <button className="mobile-demo__button mobile-demo__button--secondary" onClick={captureLocation} disabled={locating}>
            {locating ? 'Finding GPS...' : 'Use Current Location'}
          </button>
          <button className="mobile-demo__button mobile-demo__button--secondary" onClick={captureFrameAndDetect} disabled={!liveMode || detecting}>
            {detecting ? 'Detecting...' : 'Scan Frame Now'}
          </button>
        </div>

        <div className="mobile-demo__grid">
          <label className="mobile-demo__field">
            <span>Latitude</span>
            <input value={lat} onChange={(event) => setLat(event.target.value)} placeholder="33.844600" />
          </label>
          <label className="mobile-demo__field">
            <span>Longitude</span>
            <input value={lng} onChange={(event) => setLng(event.target.value)} placeholder="-117.953900" />
          </label>
        </div>

        {detectError && <div className="mobile-demo__error">{detectError}</div>}

        <div className="mobile-demo__preview">
          <div className="mobile-demo__image-wrap mobile-demo__image-wrap--live">
            <video ref={videoRef} className="mobile-demo__video" playsInline muted autoPlay />
            {!cameraReady && (
              <div className="mobile-demo__placeholder">
                Start the live scan to open the rear camera and begin watching for trash.
              </div>
            )}
            {result?.detections?.map((det, index) => {
              const [x1, y1, x2, y2] = det.bbox;
              const [width, height] = result.image_size || [1, 1];
              return (
                <div
                  key={`${det.class_name || det.class}-${index}`}
                  className="mobile-demo__bbox"
                  style={{
                    left: `${(x1 / width) * 100}%`,
                    top: `${(y1 / height) * 100}%`,
                    width: `${((x2 - x1) / width) * 100}%`,
                    height: `${((y2 - y1) / height) * 100}%`,
                  }}
                >
                  <span>{det.class_name || det.class} {(Number(det.confidence) * 100).toFixed(0)}%</span>
                </div>
              );
            })}
            {liveMode && (
              <div className="mobile-demo__live-pill">
                <span className="mobile-demo__live-dot" />
                {detecting ? 'Scanning frame...' : 'Live'}
              </div>
            )}
          </div>
          <canvas ref={canvasRef} style={{ display: 'none' }} />
        </div>
      </div>

      {result && (
        <div className="mobile-demo__panel">
          <div className="mobile-demo__result-header">
            <h2>Last Detection</h2>
            <div>{result.total_objects} object{result.total_objects === 1 ? '' : 's'} found</div>
          </div>
          <div className="mobile-demo__stats">
            <div className="mobile-demo__stat">
              <strong>{(Number(result.average_confidence || 0) * 100).toFixed(0)}%</strong>
              <span>Avg confidence</span>
            </div>
            <div className="mobile-demo__stat">
              <strong>{result.persisted_detection_count || 0}</strong>
              <span>Trash entries saved</span>
            </div>
            <div className="mobile-demo__stat">
              <strong>{result.photo_url ? 'Yes' : 'No'}</strong>
              <span>Photo uploaded</span>
            </div>
          </div>
          {result.photo_url && (
            <a className="mobile-demo__link" href={result.photo_url} target="_blank" rel="noreferrer">
              Open uploaded photo
            </a>
          )}
          {!result.photo_url && result.persistence_skipped_reason === 'no_detections' && (
            <div className="mobile-demo__hint">No trash was detected, so the backend skipped the S3 upload and trash-entry write.</div>
          )}
        </div>
      )}
      {toastMessage && <div className="mobile-demo__toast">{toastMessage}</div>}
    </div>
  );
}

// ── ROOT ──────────────────────────────────────────────────────────────────────
export default function App() {
  const dashRef = useRef(null);
  const titleRef = useRef(null);
  const [started, setStarted] = useState(false);
  const isMobileDemo = new URLSearchParams(window.location.search).get('demo') === 'mobile';

  useEffect(() => {
    window.scrollTo(0, 0);
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  }, []);

  const scrollToDash = () => {
    setStarted(true);
    // Scroll to dashboard
    setTimeout(() => {
      dashRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, 50);
    // After scroll completes, collapse title page so user can't scroll back
    setTimeout(() => {
      if (titleRef.current) {
        titleRef.current.style.height = '0';
        titleRef.current.style.minHeight = '0';
        titleRef.current.style.overflow = 'hidden';
        titleRef.current.style.opacity = '0';
      }
    }, 1100);
  };

  if (isMobileDemo) {
    return <MobileDetectorDemo />;
  }

  return (
    <div>
      <div ref={titleRef}>
        <TitlePage onEnter={scrollToDash} />
      </div>
      <div ref={dashRef}>
        <Dashboard />
      </div>
    </div>
  );
}