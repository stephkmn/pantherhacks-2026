import { createServer } from 'node:http'
import { getBuildingById, getBuildings, getSummary } from './solarModel.mjs'

const port = Number(process.env.PORT || 8787)
const host = process.env.HOST || '127.0.0.1'

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  })
  response.end(JSON.stringify(payload))
}

const server = createServer((request, response) => {
  if (!request.url) {
    sendJson(response, 400, { error: 'Missing request URL' })
    return
  }

  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    })
    response.end()
    return
  }

  const url = new URL(request.url, `http://${request.headers.host}`)

  if (request.method === 'GET' && url.pathname === '/api/summary') {
    sendJson(response, 200, getSummary())
    return
  }

  if (request.method === 'GET' && url.pathname === '/api/buildings') {
    sendJson(response, 200, { items: getBuildings() })
    return
  }

  if (request.method === 'GET' && url.pathname.startsWith('/api/buildings/')) {
    const id = decodeURIComponent(url.pathname.replace('/api/buildings/', ''))
    const building = getBuildingById(id)

    if (!building) {
      sendJson(response, 404, { error: `No building found for id "${id}"` })
      return
    }

    sendJson(response, 200, building)
    return
  }

  sendJson(response, 404, { error: 'Route not found' })
})

server.listen(port, host, () => {
  console.log(`Solar API listening on http://${host}:${port}`)
})
