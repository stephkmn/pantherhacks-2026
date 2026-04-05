import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { MapContainer, TileLayer, CircleMarker, Circle, Polyline, Popup, Tooltip, useMap } from 'react-leaflet';
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

const formatKg = (value) => Number(value || 0).toFixed(2);
const formatMinutes = (value) => Math.round(Number(value || 0));
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
function DroneCanvas({ active }) {
  const canvasRef = useRef(null);
  const animRef = useRef(null);

  useEffect(() => {
    if (!active) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let t = 0;

    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      // Drone path sweep lines
      ctx.strokeStyle = 'rgba(0,230,255,0.18)';
      ctx.lineWidth = 1;
      for (let i = 0; i < 8; i++) {
        const y = ((t * 0.4 + i * 40) % canvas.height);
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(canvas.width, y);
        ctx.stroke();
      }
      // Drone dot
      const dx = 60 + (Math.sin(t * 0.02) * 0.5 + 0.5) * (canvas.width - 120);
      const dy = 60 + (Math.sin(t * 0.013 + 1) * 0.5 + 0.5) * (canvas.height - 120);
      ctx.beginPath();
      ctx.arc(dx, dy, 7, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0,230,255,0.9)';
      ctx.fill();
      // Pulse ring
      ctx.beginPath();
      ctx.arc(dx, dy, 7 + (t % 40) * 0.6, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(0,230,255,${0.6 - (t % 40) * 0.015})`;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      t++;
      animRef.current = requestAnimationFrame(draw);
    };
    animRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(animRef.current);
  }, [active]);

  if (!active) return null;
  return (
    <canvas
      ref={canvasRef}
      width={800} height={600}
      style={{
        position: 'absolute', inset: 0, width: '100%', height: '100%',
        pointerEvents: 'none', zIndex: 500, opacity: 0.7,
      }}
    />
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
        <div className="title-eyebrow">AI-POWERED URBAN CLEANUP</div>
        <h1 className="title-logo">
          <span className="title-sky">Sky</span>
          <span className="title-sweep">Sweep</span>
        </h1>
        <p className="title-tagline">
          Autonomous drone intelligence that finds, maps, and routes<br />
          urban waste — before it becomes a crisis.
        </p>
        <button className="title-cta" onClick={onEnter}>Get Started</button>
      </div>
    </div>
  );
}
// ── PHOTO MODAL ───────────────────────────────────────────────────────────────
function PhotoModal({ hotspot, onClose }) {
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
              <span className="mstat-value">{formatKg(hotspot.estimated_waste_kg)} kg</span>
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
              ? '⚠️ Crew deployment recommended for this site'
              : '✅ Single operator sufficient'}
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
function MapClickHandler({ enabled, onMapClick }) {
  const map = useMap();
  useEffect(() => {
    if (!enabled) return;
    const handler = (e) => onMapClick([e.latlng.lat, e.latlng.lng]);
    map.on('click', handler);
    return () => map.off('click', handler);
  }, [enabled, onMapClick, map]);
  return null;
}

// ── DASHBOARD PAGE ────────────────────────────────────────────────────────────
function Dashboard() {
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
  const [activeFilter, setActiveFilter] = useState('all');
  const [scanError, setScanError] = useState('');
  const [prefetchedRoute, setPrefetchedRoute] = useState(null);

  // Active hotspots = all minus skipped
  const activeHotspots = allHotspots.filter(h => !skipped.has(h.id));

  // Recompute route whenever start pin or active hotspots change
  useEffect(() => {
    if (!startPin || !activeHotspots.length) { setRoute(null); return; }
    setRoute(buildRouteFromStart(startPin, activeHotspots));
  }, [startPin, skipped, allHotspots]);

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
    try {
      const hotspotsResponse = await axios.get('/api/hotspots', {
        params: { zip, radius_km: 2.0 },
      });
      const scanned = (hotspotsResponse.data || []).map((hotspot, idx) => ({
        id: hotspot.hotspot_id,
        lat: hotspot.lat,
        lng: hotspot.lng,
        severity: colorToSeverity(hotspot.color),
        name: `ZIP ${zip} Hotspot #${idx + 1}`,
        estimated_waste_kg: Number(hotspot.estimated_waste_kg || 0),
        cleanup_time_minutes: Number(hotspot.cleanup_time_minutes || 0),
        waste_types: [
          `${hotspot.pile_count} pile${hotspot.pile_count === 1 ? '' : 's'}`,
          `Avg size ${hotspot.avg_size}/10`,
          `Score ${hotspot.score}`,
        ],
        detected_at: hotspot.last_detected_at,
        photo: buildStreetViewUrl(hotspot.lat, hotspot.lng),
        map_preview: buildStaticMapUrl(hotspot.lat, hotspot.lng),
      }));
      setAllHotspots(scanned);

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

  const displayRoute = route || prefetchedRoute;
  const routeStops = route ? route.ordered : (prefetchedRoute?.ordered || prefetchedRoute?.hotspots || []);

  return (
    <div className="dashboard">
      {/* Top bar */}
      <header className="dash-header">
        <div className="dash-logo">
          <span className="dash-sky">Sky</span><span className="dash-sweep">Sweep</span>
        </div>
        <div className="dash-subtitle">Urban Trash Intelligence Platform</div>
      </header>

      {/* Zip input bar */}
      <div className="zip-bar">
        <div className="zip-inner">
          <div className="zip-label">📍 Enter ZIP Code to Scan</div>
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
              {scanning ? <><span className="spin">🛸</span> Scanning...</> : '🚀 Run Scan'}
            </button>
          </div>
          {scanError && (
            <div style={{ marginTop: 10, color: '#ff6b6b', fontSize: 13 }}>
              {scanError}
            </div>
          )}
          {scanning && (
            <div className="scan-progress">
              <div className="scan-bar"><div className="scan-fill" /></div>
              <span>Deploying drone over ZIP {zip}…</span>
            </div>
          )}
          {/* Start location picker prompt */}
          {scanDone && allHotspots.length > 0 && (
            <div className="start-picker-bar">
              {!startPin ? (
                <>
                  <span className="start-hint">
                    {pickingStart
                      ? '🖱️ Click anywhere on the map to set your starting location…'
                      : '📌 Set your starting location to generate a cleanup route'}
                  </span>
                  <button
                    className={`pick-btn ${pickingStart ? 'picking' : ''}`}
                    onClick={() => setPickingStart(p => !p)}
                  >
                    {pickingStart ? '✕ Cancel' : '📍 Pick Start'}
                  </button>
                </>
              ) : (
                <>
                  <span className="start-hint start-set">
                    ✅ Start set · Route covers {activeHotspots.length} stop{activeHotspots.length !== 1 ? 's' : ''}
                    {skipped.size > 0 && <span className="skipped-badge">{skipped.size} skipped</span>}
                  </span>
                  <button className="pick-btn" onClick={() => { setStartPin(null); setRoute(null); }}>
                    🔄 Reset
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Main layout */}
      <div className="dash-grid">
        {/* Map */}
        <div className={`map-wrap ${pickingStart ? 'cursor-crosshair' : ''}`}>
          <MapContainer center={mapCenter} zoom={14} style={{ height: '100%', width: '100%' }}>
            <MapRecenter center={mapCenter} />
            <TileLayer
              url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
              attribution='&copy; CartoDB'
            />
            <MapClickHandler enabled={pickingStart} onMapClick={handleMapClick} />

            {/* Hotspot markers */}
            {filtered.map(h => {
              const isSkipped = skipped.has(h.id);
              const routeIdx = routeStops.findIndex(r => r.id === h.id);
              return (
                <React.Fragment key={h.id}>
                  <CircleMarker
                    center={[h.lat, h.lng]}
                    radius={12}
                    fillColor={isSkipped ? '#444' : getSeverityColor(h.severity)}
                    color={isSkipped ? '#666' : '#fff'}
                    weight={2}
                    fillOpacity={isSkipped ? 0.35 : 0.9}
                    eventHandlers={{ click: () => !isSkipped && setSelectedHotspot(h) }}
                  >
                    <Tooltip direction="top" offset={[0, -8]} opacity={1}>
                      <div style={{ width: 170 }}>
                        <HotspotImage
                          hotspot={h}
                          alt="Trash placeholder"
                          style={{ width: '100%', borderRadius: 6, display: 'block' }}
                        />
                      </div>
                    </Tooltip>
                    <Popup>
                      <div style={{ fontFamily: 'monospace', fontSize: 13 }}>
                        <strong>{h.name}</strong><br />
                        <span style={{ color: getSeverityColor(h.severity) }}>● {h.severity.toUpperCase()}</span><br />
                        {formatKg(h.estimated_waste_kg)} kg · {formatMinutes(h.cleanup_time_minutes)} min<br />
                        <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                          <button onClick={() => setSelectedHotspot(h)}
                            style={{ padding: '4px 10px', background: '#0ea5e9', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>
                            📸 Photo
                          </button>
                          <button onClick={(e) => toggleSkip(h.id, e)}
                            style={{ padding: '4px 10px', background: isSkipped ? '#22c55e' : '#ff3b3b', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>
                            {isSkipped ? '+ Restore' : '✕ Skip'}
                          </button>
                        </div>
                      </div>
                    </Popup>
                  </CircleMarker>
                  {!isSkipped && (
                    <Circle
                      center={[h.lat, h.lng]}
                      radius={SEV_RADIUS[h.severity]}
                      fillColor={getSeverityColor(h.severity)}
                      color={getSeverityColor(h.severity)}
                      weight={1} opacity={0.4} fillOpacity={0.12}
                    />
                  )}
                </React.Fragment>
              );
            })}

            {/* Route polyline */}
            {displayRoute && (
              <Polyline
                positions={displayRoute.route_coordinates}
                color="#00e5ff" weight={3} opacity={0.85} dashArray="8,5"
              />
            )}

            {/* Start pin marker */}
            {startPin && (
              <CircleMarker
                center={startPin}
                radius={14}
                fillColor="#ffffff"
                color="#00e5ff"
                weight={3}
                fillOpacity={1}
              >
                <Popup>
                  <div style={{ fontFamily: 'monospace', fontSize: 13, textAlign: 'center' }}>
                    <strong>📍 Your Start</strong><br />
                    {activeHotspots.length} stops from here
                  </div>
                </Popup>
              </CircleMarker>
            )}

            <DroneCanvas active={scanning} />
          </MapContainer>

          {/* Crosshair overlay when picking */}
          {pickingStart && (
            <div className="crosshair-overlay">
              <div className="crosshair-msg">Click to drop your start pin</div>
            </div>
          )}

          {!scanDone && !scanning && (
            <div className="map-idle">
              <div className="map-idle-icon">🛸</div>
              <div>Enter a ZIP code above to deploy drone scan</div>
            </div>
          )}
          {scanDone && !scanning && allHotspots.length === 0 && (
            <div className="map-idle">
              <div className="map-idle-icon">✅</div>
              <div>No hotspots detected for this scan.</div>
            </div>
          )}
        </div>

        {/* Sidebar */}
        <div className="sidebar">
          {/* Stats */}
          {scanDone && (
            <div className="stats-row">
              <div className="stat-box">
                <div className="stat-num">{activeHotspots.length}</div>
                <div className="stat-lbl">Active Stops</div>
              </div>
              <div className="stat-box">
                <div className="stat-num">{formatKg(activeHotspots.reduce((s,h)=>s+h.estimated_waste_kg,0))}<small>kg</small></div>
                <div className="stat-lbl">Est. Waste</div>
              </div>
              <div className="stat-box">
                <div className="stat-num">{formatMinutes(activeHotspots.reduce((s,h)=>s+h.cleanup_time_minutes,0))}<small>m</small></div>
                <div className="stat-lbl">Cleanup Time</div>
              </div>
              {displayRoute && (
                <div className="stat-box">
                  <div className="stat-num">{displayRoute.total_distance_km}<small>km</small></div>
                  <div className="stat-lbl">Route Dist.</div>
                </div>
              )}
            </div>
          )}

          {/* Filter tabs */}
          {scanDone && (
            <div className="filter-tabs">
              {['all', 'high', 'medium', 'low'].map(f => (
                <button key={f} className={`ftab ${activeFilter === f ? 'active' : ''} ftab-${f}`}
                  onClick={() => setActiveFilter(f)}>
                  {f === 'all' ? 'All' : f.charAt(0).toUpperCase() + f.slice(1)}
                </button>
              ))}
            </div>
          )}

          {/* Hotspot list */}
          {filtered.length > 0 && (
            <div className="hotspot-list-scroll">
              <div className="list-title">📍 Detected Hotspots</div>
              {filtered.map((h, i) => {
                const isSkipped = skipped.has(h.id);
                return (
                  <div key={h.id}
                    className={`hspot-card sev-${h.severity} ${isSkipped ? 'hspot-skipped' : ''}`}
                    onClick={() => !isSkipped && setSelectedHotspot(h)}
                  >
                    <div className="hspot-top">
                      <div className="hspot-rank">#{i + 1}</div>
                      <div className="hspot-name">{h.name}</div>
                      <div className="hspot-badge" style={{ background: isSkipped ? '#444' : getSeverityColor(h.severity) }}>
                        {isSkipped ? 'SKIPPED' : h.severity.toUpperCase()}
                      </div>
                    </div>
                    <div className="hspot-meta">
                      <span>⚖️ {formatKg(h.estimated_waste_kg)} kg</span>
                      <span>⏱ {formatMinutes(h.cleanup_time_minutes)} min</span>
                    </div>
                    <div className="hspot-types">
                      {h.waste_types.map(t => <span key={t} className="wtype">{t}</span>)}
                    </div>
                    <div className="hspot-actions">
                      {!isSkipped && <div className="hspot-photo-hint">📸 Click to view site photo</div>}
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
          {displayRoute && scanDone && routeStops.length > 0 && (
            <div className="route-panel">
              <div className="list-title">🗺️ Your Cleanup Route</div>
              <div className="route-start-label">{startPin ? '📍 Your Start →' : '🧭 Suggested Route'}</div>
              {routeStops.map((h, i) => (
                <div key={h.id} className="route-step-card">
                  <div className="rstep-num" style={{ background: getSeverityColor(h.severity) }}>{i + 1}</div>
                  <div style={{ flex: 1 }}>
                    <div className="rstep-name">{h.name}</div>
                    <div className="rstep-meta">{formatKg(h.estimated_waste_kg)} kg · {formatMinutes(h.cleanup_time_minutes)} min</div>
                  </div>
                  <button className="rstep-skip" onClick={(e) => toggleSkip(h.id, e)} title="Skip this stop">✕</button>
                </div>
              ))}
              <div className="route-summary-pill">
                {displayRoute.total_distance_km} km · {formatMinutes(displayRoute.total_time_minutes)} min · {formatKg(displayRoute.total_waste_kg)} kg total
              </div>
            </div>
          )}

          {/* No start pin yet but scan done */}
          {scanDone && !startPin && (
            <div className="sidebar-empty" style={{ marginTop: 12 }}>
              <div style={{ fontSize: 32 }}>📍</div>
              <div>Click <strong>"Pick Start"</strong> above then tap the map to set where you're cleaning from</div>
            </div>
          )}

          {!scanDone && !scanning && (
            <div className="sidebar-empty">
              <div style={{ fontSize: 40 }}>🛸</div>
              <div>Scan results will appear here</div>
            </div>
          )}
          {scanning && (
            <div className="sidebar-empty">
              <div className="big-spin">🛸</div>
              <div>Drone scanning ZIP {zip}…</div>
              <div style={{ fontSize: 12, opacity: 0.6, marginTop: 4 }}>Detecting trash hotspots via YOLO</div>
            </div>
          )}
          {scanDone && !scanning && allHotspots.length === 0 && (
            <div className="sidebar-empty">
              <div style={{ fontSize: 40 }}>✅</div>
              <div>No hotspots found in this scan.</div>
            </div>
          )}
        </div>
      </div>

      <PhotoModal hotspot={selectedHotspot} onClose={() => setSelectedHotspot(null)} />
    </div>
  );
}

// ── ROOT ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [page, setPage] = useState('title');
  return page === 'title'
    ? <TitlePage onEnter={() => setPage('dashboard')} />
    : <Dashboard />;
}
