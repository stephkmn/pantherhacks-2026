import { pilotArea, rawBuildings } from './data/pilotBuildings.mjs'

const PANEL_AREA_M2 = 2
const PANEL_WATTAGE = 430

function classifyBuilding(footprintAreaM2) {
  if (footprintAreaM2 >= 4500) {
    return 'civic-campus'
  }

  if (footprintAreaM2 >= 2600) {
    return 'commercial'
  }

  if (footprintAreaM2 >= 1400) {
    return 'mixed-use'
  }

  return 'residential'
}

function getUsabilityFactor(buildingClass) {
  switch (buildingClass) {
    case 'civic-campus':
      return 0.5
    case 'commercial':
      return 0.46
    case 'mixed-use':
      return 0.4
    default:
      return 0.35
  }
}

function getShadingFactor(lat, lng) {
  const seed = Math.abs(Math.round((lat * 1000 + lng * 1000) * 17)) % 10
  return 0.88 + seed * 0.01
}

function getRoofReadiness(buildingClass) {
  switch (buildingClass) {
    case 'civic-campus':
      return 0.96
    case 'commercial':
      return 0.93
    case 'mixed-use':
      return 0.89
    default:
      return 0.84
  }
}

function getConfidenceScore(buildingClass, shadingFactor) {
  const baseByClass = {
    'civic-campus': 0.91,
    commercial: 0.87,
    'mixed-use': 0.8,
    residential: 0.74,
  }

  const score = baseByClass[buildingClass] * shadingFactor
  return Math.max(0.58, Math.min(0.97, Number(score.toFixed(2))))
}

function getOpportunityBand(score) {
  if (score >= 80) {
    return 'high'
  }

  if (score >= 60) {
    return 'medium'
  }

  return 'low'
}

function createExplanation({ name, buildingClass, opportunityBand, usabilityFactor, shadingFactor }) {
  const roofType = buildingClass === 'residential' ? 'smaller roof' : 'broad roof plate'
  const bandText = {
    high: 'high-potential',
    medium: 'medium-potential',
    low: 'lower-potential',
  }

  return `${name} scores as a ${bandText[opportunityBand]} rooftop because it has a ${roofType}, an estimated ${Math.round(
    usabilityFactor * 100,
  )}% usable surface, and a shading factor of ${shadingFactor.toFixed(2)}.`
}

function modelBuilding(building) {
  const buildingClass = classifyBuilding(building.footprintAreaM2)
  const usabilityFactor = getUsabilityFactor(buildingClass)
  const shadingFactor = getShadingFactor(building.lat, building.lng)
  const roofReadiness = getRoofReadiness(buildingClass)

  const usableRoofAreaM2 = Number(
    (building.footprintAreaM2 * usabilityFactor * shadingFactor).toFixed(1),
  )
  const estimatedPanels = Math.max(1, Math.floor(usableRoofAreaM2 / PANEL_AREA_M2))
  const estimatedCapacityKw = Number(
    ((estimatedPanels * PANEL_WATTAGE) / 1000).toFixed(1),
  )
  const estimatedAnnualKwh = Math.round(
    estimatedCapacityKw * pilotArea.solarYieldKwhPerKw * roofReadiness,
  )
  const estimatedCo2OffsetKg = Math.round(
    estimatedAnnualKwh * pilotArea.gridEmissionsKgPerKwh,
  )

  const normalizedRoof = Math.min(building.footprintAreaM2 / 6000, 1)
  const opportunityScore = Math.round(
    normalizedRoof * 48 + usabilityFactor * 24 + shadingFactor * 18 + roofReadiness * 10,
  )
  const opportunityBand = getOpportunityBand(opportunityScore)
  const confidence = getConfidenceScore(buildingClass, shadingFactor)

  return {
    ...building,
    buildingClass,
    usabilityFactor,
    shadingFactor: Number(shadingFactor.toFixed(2)),
    roofReadiness,
    usableRoofAreaM2,
    estimatedPanels,
    estimatedCapacityKw,
    estimatedAnnualKwh,
    estimatedCo2OffsetKg,
    opportunityScore,
    opportunityBand,
    confidence,
    explanation: createExplanation({
      name: building.name,
      buildingClass,
      opportunityBand,
      usabilityFactor,
      shadingFactor,
    }),
  }
}

export const buildingModels = rawBuildings
  .map(modelBuilding)
  .sort((left, right) => right.opportunityScore - left.opportunityScore)

export const summaryModel = {
  area: pilotArea,
  candidateBuildings: buildingModels.length,
  estimatedAdditionalPanels: buildingModels.reduce(
    (sum, building) => sum + building.estimatedPanels,
    0,
  ),
  estimatedCapacityKw: Number(
    buildingModels.reduce((sum, building) => sum + building.estimatedCapacityKw, 0).toFixed(1),
  ),
  estimatedAnnualKwh: buildingModels.reduce(
    (sum, building) => sum + building.estimatedAnnualKwh,
    0,
  ),
  estimatedCo2OffsetKg: buildingModels.reduce(
    (sum, building) => sum + building.estimatedCo2OffsetKg,
    0,
  ),
  assumptions: {
    panelAreaM2: PANEL_AREA_M2,
    panelWattage: PANEL_WATTAGE,
    solarYieldKwhPerKw: pilotArea.solarYieldKwhPerKw,
    emissionsKgPerKwh: pilotArea.gridEmissionsKgPerKwh,
  },
}

export function getSummary() {
  return summaryModel
}

export function getBuildings() {
  return buildingModels.map((building) => ({
    id: building.id,
    name: building.name,
    neighborhood: building.neighborhood,
    lat: building.lat,
    lng: building.lng,
    footprintAreaM2: building.footprintAreaM2,
    estimatedPanels: building.estimatedPanels,
    estimatedCapacityKw: building.estimatedCapacityKw,
    estimatedAnnualKwh: building.estimatedAnnualKwh,
    opportunityScore: building.opportunityScore,
    opportunityBand: building.opportunityBand,
    confidence: building.confidence,
    polygon: building.polygon,
  }))
}

export function getBuildingById(id) {
  const building = buildingModels.find((entry) => entry.id === id)

  if (!building) {
    return null
  }

  return {
    id: building.id,
    name: building.name,
    neighborhood: building.neighborhood,
    lat: building.lat,
    lng: building.lng,
    buildingClass: building.buildingClass,
    footprintAreaM2: building.footprintAreaM2,
    usableRoofAreaM2: building.usableRoofAreaM2,
    usabilityFactor: building.usabilityFactor,
    estimatedPanels: building.estimatedPanels,
    estimatedCapacityKw: building.estimatedCapacityKw,
    estimatedAnnualKwh: building.estimatedAnnualKwh,
    estimatedCo2OffsetKg: building.estimatedCo2OffsetKg,
    opportunityScore: building.opportunityScore,
    opportunityBand: building.opportunityBand,
    confidence: building.confidence,
    explanation: building.explanation,
    polygon: building.polygon,
  }
}
