import React, { useState } from 'react';
import { MapContainer, TileLayer, CircleMarker, Circle, Polyline, Popup } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';

function App() {
  const mapCenter = [33.8366, -117.9143]; // Anaheim

  const mockHotspots = [
    { id: 1, lat: 33.837, lng: -117.915, severity: 'high', name: 'Trash Point 1', estimated_waste_kg: 12, cleanup_time_minutes: 15, waste_types: ['Plastic'], confidence: 0.9 },
    { id: 2, lat: 33.835, lng: -117.913, severity: 'medium', name: 'Trash Point 2', estimated_waste_kg: 5, cleanup_time_minutes: 10, waste_types: ['Paper'], confidence: 0.8 },
    { id: 3, lat: 33.836, lng: -117.912, severity: 'low', name: 'Trash Point 3', estimated_waste_kg: 3, cleanup_time_minutes: 5, waste_types: ['Glass'], confidence: 0.7 },
  ];

  const mockRoute = {
    route_coordinates: mockHotspots.map(h => [h.lat, h.lng]),
    total_distance_km: 2.5,
    total_time_minutes: 30,
    total_waste_kg: 20,
    hotspots: mockHotspots,
  };

  const getSeverityColor = (severity) => {
    switch(severity) {
      case 'high': return '#e74c3c';
      case 'medium': return '#f39c12';
      case 'low': return '#27ae60';
      default: return '#3498db';
    }
  };

  return (
    <div className="app">
      <header className="header">
        <h1>🛸 CleanSky AI</h1>
        <p>AI-Powered Urban Trash Detection & Route Optimization</p>
      </header>

      <div className="container">
        <div className="main-grid">
          <div className="map-container">
            <MapContainer center={mapCenter} zoom={14} style={{ height: '100%', width: '100%' }}>
              <TileLayer
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                attribution='&copy; OpenStreetMap contributors'
              />
              {mockHotspots.map(h => (
                <div key={h.id}>
                  <CircleMarker
                    center={[h.lat, h.lng]}
                    radius={10}
                    fillColor={getSeverityColor(h.severity)}
                    color="#fff"
                    weight={2}
                    fillOpacity={0.8}
                  >
                    <Popup>
                      <strong>{h.name}</strong><br />
                      Severity: {h.severity.toUpperCase()}<br />
                      Waste: {h.estimated_waste_kg} kg<br />
                      Types: {h.waste_types.join(', ')}<br />
                      Cleanup: {h.cleanup_time_minutes} min<br />
                      Confidence: {(h.confidence * 100).toFixed(0)}%
                    </Popup>
                  </CircleMarker>

                  <Circle
                    center={[h.lat, h.lng]}
                    radius={h.severity === 'high' ? 200 : h.severity === 'medium' ? 150 : 100}
                    fillColor={getSeverityColor(h.severity)}
                    color={getSeverityColor(h.severity)}
                    weight={1}
                    opacity={0.3}
                    fillOpacity={0.2}
                  />
                </div>
              ))}

              <Polyline positions={mockRoute.route_coordinates} color="#667eea" weight={3} opacity={0.7} dashArray="10,5" />
            </MapContainer>
          </div>

          <div className="stats-panel">
            <h2>📊 Detection Statistics</h2>
            <div className="stat-card">
              <div className="stat-icon">📍</div>
              <div>
                <h3>Hotspots Detected</h3>
                <div className="value">{mockHotspots.length}</div>
              </div>
            </div>

            <div className="stat-card">
              <div className="stat-icon">⚖️</div>
              <div>
                <h3>Estimated Waste</h3>
                <div className="value">{mockHotspots.reduce((sum,h)=>sum+h.estimated_waste_kg,0)} kg</div>
              </div>
            </div>

            <div className="stat-card">
              <div className="stat-icon">⏱️</div>
              <div>
                <h3>Cleanup Time</h3>
                <div className="value">{mockHotspots.reduce((sum,h)=>sum+h.cleanup_time_minutes,0)} min</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;