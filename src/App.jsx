import { useEffect, useRef, useState } from 'react'
import './App.css'

const currencyFreeNumber = new Intl.NumberFormat('en-US')

function formatCompactNumber(value) {
  return new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value)
}

function formatMetric(value, suffix) {
  return `${currencyFreeNumber.format(value)} ${suffix}`
}

function getApiUrl(path) {
  const configuredBase = import.meta.env.VITE_API_BASE_URL
  return configuredBase ? `${configuredBase}${path}` : path
}

function getBandClass(opportunityBand) {
  if (opportunityBand === 'high') {
    return 'band-high'
  }

  if (opportunityBand === 'medium') {
    return 'band-medium'
  }

  return 'band-low'
}

function useGoogleMapsLoader(apiKey) {
  const [state, setState] = useState(() => {
    if (!apiKey) {
      return 'missing-key'
    }

    if (window.google?.maps) {
      return 'ready'
    }

    return 'loading'
  })

  useEffect(() => {
    if (!apiKey || window.google?.maps) {
      return
    }

    const script = document.createElement('script')
    script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}`
    script.async = true
    script.onload = () => setState('ready')
    script.onerror = () => setState('error')
    document.head.appendChild(script)

    return () => {
      document.head.removeChild(script)
    }
  }, [apiKey])

  return state
}

function SummaryCard({ label, value, hint, tone = 'neutral' }) {
  return (
    <article className={`summary-card summary-card-${tone}`}>
      <span className="summary-label">{label}</span>
      <strong className="summary-value">{value}</strong>
      <span className="summary-hint">{hint}</span>
    </article>
  )
}

function RankList({ buildings, selectedId, onSelect }) {
  return (
    <section className="panel list-panel">
      <div className="panel-header">
        <div>
          <p className="eyebrow">Priority list</p>
          <h3>Top opportunity rooftops</h3>
        </div>
      </div>
      <div className="rank-list">
        {buildings.map((building, index) => (
          <button
            key={building.id}
            type="button"
            className={`rank-item ${selectedId === building.id ? 'selected' : ''}`}
            onClick={() => onSelect(building.id)}
          >
            <span className="rank-index">#{index + 1}</span>
            <span className="rank-copy">
              <strong>{building.name}</strong>
              <span>{building.neighborhood}</span>
            </span>
            <span className={`rank-band ${getBandClass(building.opportunityBand)}`}>
              {building.opportunityScore}
            </span>
          </button>
        ))}
      </div>
    </section>
  )
}

function DetailPanel({ selectedBuilding }) {
  if (!selectedBuilding) {
    return (
      <section className="panel detail-panel empty-state">
        <p className="eyebrow">Building details</p>
        <h3>Select a rooftop on the map</h3>
        <p>
          Compare buildings, inspect their solar readiness score, and use the
          side panel to tell the story behind the city-wide totals.
        </p>
      </section>
    )
  }

  return (
    <section className="panel detail-panel">
      <div className="panel-header">
        <div>
          <p className="eyebrow">Building details</p>
          <h3>{selectedBuilding.name}</h3>
        </div>
        <span className={`pill ${getBandClass(selectedBuilding.opportunityBand)}`}>
          {selectedBuilding.opportunityBand} potential
        </span>
      </div>

      <p className="detail-location">{selectedBuilding.neighborhood}</p>
      <p className="detail-description">{selectedBuilding.explanation}</p>

      <div className="detail-grid">
        <div>
          <span>Usable roof</span>
          <strong>{formatMetric(Math.round(selectedBuilding.usableRoofAreaM2), 'm²')}</strong>
        </div>
        <div>
          <span>Additional panels</span>
          <strong>{currencyFreeNumber.format(selectedBuilding.estimatedPanels)}</strong>
        </div>
        <div>
          <span>Capacity</span>
          <strong>{formatMetric(selectedBuilding.estimatedCapacityKw, 'kW')}</strong>
        </div>
        <div>
          <span>Annual output</span>
          <strong>{formatMetric(selectedBuilding.estimatedAnnualKwh, 'kWh')}</strong>
        </div>
      </div>

      <div className="detail-metadata">
        <div>
          <span>Opportunity score</span>
          <strong>{selectedBuilding.opportunityScore}/100</strong>
        </div>
        <div>
          <span>Confidence</span>
          <strong>{Math.round(selectedBuilding.confidence * 100)}%</strong>
        </div>
        <div>
          <span>Footprint class</span>
          <strong>{selectedBuilding.buildingClass}</strong>
        </div>
      </div>
    </section>
  )
}

function OpportunityMap({
  buildings,
  bounds,
  center,
  selectedId,
  onSelect,
  mapMode,
}) {
  const mapRef = useRef(null)
  const mapInstanceRef = useRef(null)
  const shapesRef = useRef([])

  useEffect(() => {
    if (mapMode !== 'google-ready' || !mapRef.current || !window.google?.maps) {
      return
    }

    if (!mapInstanceRef.current) {
      mapInstanceRef.current = new window.google.maps.Map(mapRef.current, {
        center,
        zoom: 14,
        mapTypeId: 'satellite',
        disableDefaultUI: true,
        zoomControl: true,
        gestureHandling: 'greedy',
        styles: [{ featureType: 'poi', stylers: [{ visibility: 'off' }] }],
      })
    }

    const map = mapInstanceRef.current
    const fittedBounds = new window.google.maps.LatLngBounds(
      { lat: bounds.south, lng: bounds.west },
      { lat: bounds.north, lng: bounds.east },
    )
    map.fitBounds(fittedBounds, 44)

    shapesRef.current.forEach((shape) => shape.setMap(null))
    shapesRef.current = buildings.map((building) => {
      const polygon = new window.google.maps.Polygon({
        paths: building.polygon,
        strokeColor: '#f5f1dd',
        strokeOpacity: 0.85,
        strokeWeight: selectedId === building.id ? 3 : 1.5,
        fillColor:
          building.opportunityBand === 'high'
            ? '#f4b400'
            : building.opportunityBand === 'medium'
              ? '#ff7a59'
              : '#63c174',
        fillOpacity: selectedId === building.id ? 0.7 : 0.5,
        map,
      })

      polygon.addListener('click', () => onSelect(building.id))
      return polygon
    })

    return () => {
      shapesRef.current.forEach((shape) => shape.setMap(null))
      shapesRef.current = []
    }
  }, [bounds, buildings, center, mapMode, onSelect, selectedId])

  if (mapMode !== 'google-ready') {
    return (
      <div className="map-fallback">
        <div className="map-fallback-copy">
          <p className="eyebrow">Map preview</p>
          <h3>Interactive solar opportunity canvas</h3>
          <p>
            Add `VITE_GOOGLE_MAPS_API_KEY` to enable the live Google satellite
            map. The fallback keeps the full demo flow working in the meantime.
          </p>
        </div>
        <div className="fallback-stage">
          {buildings.map((building) => {
            const x = ((building.lng - bounds.west) / (bounds.east - bounds.west)) * 100
            const y = (1 - (building.lat - bounds.south) / (bounds.north - bounds.south)) * 100

            return (
              <button
                key={building.id}
                type="button"
                className={`fallback-marker ${selectedId === building.id ? 'selected' : ''} ${getBandClass(building.opportunityBand)}`}
                style={{ left: `${x}%`, top: `${y}%` }}
                onClick={() => onSelect(building.id)}
              >
                <span>{building.estimatedPanels}</span>
              </button>
            )
          })}
        </div>
      </div>
    )
  }

  return <div ref={mapRef} className="map-canvas" />
}

function App() {
  const [summary, setSummary] = useState(null)
  const [buildings, setBuildings] = useState([])
  const [selectedId, setSelectedId] = useState(null)
  const [selectedBuilding, setSelectedBuilding] = useState(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState('')

  const mapLoaderState = useGoogleMapsLoader(import.meta.env.VITE_GOOGLE_MAPS_API_KEY)

  useEffect(() => {
    let isCancelled = false

    async function loadDashboard() {
      setIsLoading(true)
      setError('')

      try {
        const [summaryResponse, buildingsResponse] = await Promise.all([
          fetch(getApiUrl('/api/summary')),
          fetch(getApiUrl('/api/buildings')),
        ])

        if (!summaryResponse.ok || !buildingsResponse.ok) {
          throw new Error('Unable to load pilot solar data')
        }

        const summaryPayload = await summaryResponse.json()
        const buildingsPayload = await buildingsResponse.json()

        if (isCancelled) {
          return
        }

        setSummary(summaryPayload)
        setBuildings(buildingsPayload.items)

        if (buildingsPayload.items.length > 0) {
          setSelectedId((current) => current ?? buildingsPayload.items[0].id)
        }
      } catch (loadError) {
        if (!isCancelled) {
          setError(loadError.message)
        }
      } finally {
        if (!isCancelled) {
          setIsLoading(false)
        }
      }
    }

    loadDashboard()

    return () => {
      isCancelled = true
    }
  }, [])

  useEffect(() => {
    if (!selectedId) {
      setSelectedBuilding(null)
      return
    }

    let isCancelled = false

    async function loadBuildingDetail() {
      try {
        const response = await fetch(getApiUrl(`/api/buildings/${selectedId}`))
        if (!response.ok) {
          throw new Error('Unable to load building detail')
        }

        const payload = await response.json()
        if (!isCancelled) {
          setSelectedBuilding(payload)
        }
      } catch (detailError) {
        if (!isCancelled) {
          setError(detailError.message)
        }
      }
    }

    loadBuildingDetail()

    return () => {
      isCancelled = true
    }
  }, [selectedId])

  const topBuildings = buildings.slice(0, 10)
  const mapMode = mapLoaderState === 'ready' ? 'google-ready' : mapLoaderState

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div className="hero-copy">
          <p className="eyebrow">Solar Potential Mapper</p>
          <h1>How much more rooftop solar could this city realistically add?</h1>
          <p className="hero-description">
            A demo-first planning tool for climate teams that combines rooftop
            heuristics, explainable scoring, and an interactive map of untapped
            solar opportunity.
          </p>
        </div>
        <div className="hero-badge">
          <span>Pilot area</span>
          <strong>{summary?.area.name ?? 'Loading pilot geography...'}</strong>
        </div>
      </section>

      {error ? <p className="banner banner-error">{error}</p> : null}

      {isLoading || !summary ? (
        <section className="loading-panel">
          <p className="eyebrow">Preparing the dashboard</p>
          <h2>Loading rooftop candidates and city-level estimates...</h2>
        </section>
      ) : (
        <>
          <section className="summary-grid">
            <SummaryCard
              label="Additional panels"
              value={formatCompactNumber(summary.estimatedAdditionalPanels)}
              hint={`${summary.candidateBuildings} candidate rooftops`}
              tone="gold"
            />
            <SummaryCard
              label="Added capacity"
              value={formatMetric(summary.estimatedCapacityKw, 'kW')}
              hint="Directional planning estimate"
              tone="coral"
            />
            <SummaryCard
              label="Annual generation"
              value={formatCompactNumber(summary.estimatedAnnualKwh)}
              hint="Estimated yearly output in kWh"
              tone="green"
            />
            <SummaryCard
              label="CO2 offset"
              value={formatCompactNumber(summary.estimatedCo2OffsetKg)}
              hint="Avoided emissions in kg CO2e"
            />
          </section>

          <section className="workspace-grid">
            <section className="panel map-panel">
              <div className="panel-header">
                <div>
                  <p className="eyebrow">Opportunity map</p>
                  <h3>{summary.area.name}</h3>
                </div>
                <span className="pill">{mapMode === 'google-ready' ? 'Google Maps live' : 'Fallback mode'}</span>
              </div>
              <OpportunityMap
                buildings={buildings}
                bounds={summary.area.bounds}
                center={summary.area.center}
                selectedId={selectedId}
                onSelect={setSelectedId}
                mapMode={mapMode}
              />
            </section>

            <div className="sidebar">
              <DetailPanel selectedBuilding={selectedBuilding} />
              <RankList
                buildings={topBuildings}
                selectedId={selectedId}
                onSelect={setSelectedId}
              />
            </div>
          </section>

          <section className="panel assumptions-panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Model assumptions</p>
                <h3>Fast, explainable, hackathon-friendly estimation</h3>
              </div>
            </div>
            <div className="assumptions-grid">
              <div>
                <span>Panel wattage</span>
                <strong>{summary.assumptions.panelWattage}W panels</strong>
              </div>
              <div>
                <span>Panel area</span>
                <strong>{summary.assumptions.panelAreaM2} m² per panel</strong>
              </div>
              <div>
                <span>Solar yield</span>
                <strong>{summary.assumptions.solarYieldKwhPerKw} kWh/kW/year</strong>
              </div>
              <div>
                <span>Emissions factor</span>
                <strong>{summary.assumptions.emissionsKgPerKwh} kg CO2e/kWh</strong>
              </div>
            </div>
          </section>
        </>
      )}
    </main>
  )
}

export default App
