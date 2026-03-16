#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
  ListToolsRequestSchema,
  CallToolRequestSchema
} from "@modelcontextprotocol/sdk/types.js"

const APIOSK_API_LIST = process.env.APIOSK_API_LIST || "https://gateway.apiosk.com/v1/apis"
const APIOSK_GATEWAY = process.env.APIOSK_GATEWAY || "https://gateway.apiosk.com"

const server = new Server(
  { name: "apiosk-mcp", version: "1.1.0" },
  { capabilities: { tools: {} } }
)

// Cache for API list to speed up inspect
let apiCache = null
let apiCacheTime = 0
const CACHE_TTL = 60000 // 1 minute

async function getApiList() {
  if (apiCache && Date.now() - apiCacheTime < CACHE_TTL) {
    return apiCache
  }

  let allApis = []
  let currentOffset = 0
  const pageSize = 100

  while (true) {
    const r = await fetch(`${APIOSK_API_LIST}?limit=${pageSize}&offset=${currentOffset}`)
    const data = await r.json()
    allApis = allApis.concat(data.apis || [])
    if (!data.meta || allApis.length >= data.meta.total) break
    currentOffset += pageSize
  }

  apiCache = allApis
  apiCacheTime = Date.now()
  return allApis
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "apiosk",
      description: `Apiosk API Gateway - discover and execute paid APIs.

ACTIONS:
1. list - Browse available APIs (returns: id, name, description, price_usd, category, docs_url)
2. inspect - Get full details for a specific API including endpoint paths
3. execute - Run an API endpoint with payload

WORKFLOW:
1. Use 'list' to find APIs (optionally filter by search/category)
2. Use 'inspect' with the API id to get details and available endpoints
3. Use 'execute' with api slug, path, and payload to call the API

EXAMPLE (Zeppay payment link):
{
  "action": "execute",
  "api": "zeppay",
  "path": "/api/payment-links",
  "payload": {
    "amount": "25",
    "currency": "USD",
    "destination_wallet": "0x..."
  }
}`,
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["list", "inspect", "execute"],
            description: "list = browse APIs, inspect = get API details + docs link, execute = call an API"
          },
          api: {
            type: "string",
            description: "API id/slug (required for inspect and execute). Get this from 'list' action."
          },
          payload: {
            type: "object",
            description: "Request payload for execute. Check docs_url for required fields."
          },
          path: {
            type: "string",
            description: "Endpoint path for execute (e.g., '/api/payment-links'). Required for execute."
          },
          method: {
            type: "string",
            enum: ["GET", "POST", "PUT", "DELETE"],
            description: "HTTP method for execute (default: POST)"
          },
          search: {
            type: "string",
            description: "Search query to filter APIs (for list action)"
          },
          category: {
            type: "string",
            description: "Filter by category (for list action)"
          },
          limit: {
            type: "number",
            description: "Max results to return (for list action, default: 20)"
          },
          offset: {
            type: "number",
            description: "Skip first N results (for list action)"
          }
        },
        required: ["action"]
      }
    }
  ]
}))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { action, api, payload, path, method, limit, offset, search, category } = req.params.arguments || {}

  try {
    if (action === "list") {
      const params = new URLSearchParams()
      params.set("limit", limit || 20)
      if (offset) params.set("offset", offset)
      if (search) params.set("search", search)
      if (category) params.set("category", category)

      const r = await fetch(`${APIOSK_API_LIST}?${params}`)
      const data = await r.json()

      const result = {
        apis: data.apis?.map(a => ({
          id: a.id,
          name: a.name,
          description: a.description,
          price_usd: a.price_usd,
          category: a.category,
          docs_url: a.docs_url
        })),
        meta: data.meta,
        next_steps: "Use 'inspect' with an API id to get full details, or visit docs_url for documentation."
      }

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] }
    }

    if (action === "inspect") {
      if (!api) {
        return { content: [{ type: "text", text: "Error: 'api' parameter required. Use 'list' first to find API ids." }], isError: true }
      }

      const allApis = await getApiList()
      const apiInfo = allApis.find(a => a.id === api || a.slug === api)

      if (!apiInfo) {
        return {
          content: [{ type: "text", text: `API '${api}' not found. Use 'list' to see available APIs.` }],
          isError: true
        }
      }

      // Fetch endpoint details from the gateway
      let endpoints = []
      try {
        const endpointRes = await fetch(`${APIOSK_GATEWAY}/${apiInfo.slug}`, {
          headers: { "Accept": "application/json" }
        })
        if (endpointRes.ok) {
          const endpointData = await endpointRes.json()
          endpoints = endpointData.endpoints || []
        }
      } catch (e) {
        // Ignore endpoint fetch errors
      }

      const result = {
        ...apiInfo,
        endpoints: endpoints.map(ep => ({
          method: ep.method,
          path: ep.path,
          price_usdc: ep.price_usdc,
          payment_required: ep.payment_required,
          full_url: ep.gateway_url
        })),
        how_to_execute: endpoints.length > 0 ? {
          action: "execute",
          api: apiInfo.slug,
          path: endpoints.find(e => e.method === "POST")?.path || endpoints[0]?.path,
          method: "POST",
          payload: "{ ... }"
        } : null,
        documentation: apiInfo.docs_url
      }

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] }
    }

    if (action === "execute") {
      if (!api) {
        return { content: [{ type: "text", text: "Error: 'api' parameter required for execute" }], isError: true }
      }
      if (!path) {
        return { content: [{ type: "text", text: "Error: 'path' parameter required for execute. Use 'inspect' to see available endpoints." }], isError: true }
      }

      // Build the full gateway URL: https://gateway.apiosk.com/{api_slug}{path}
      const endpointPath = path.startsWith('/') ? path : `/${path}`
      const gatewayUrl = `${APIOSK_GATEWAY}/${api}${endpointPath}`
      const httpMethod = method || "POST"

      const fetchOptions = {
        method: httpMethod,
        headers: { "Content-Type": "application/json" }
      }

      // Only include body for methods that support it
      if (["POST", "PUT", "PATCH"].includes(httpMethod) && payload) {
        fetchOptions.body = JSON.stringify(payload)
      }

      const r = await fetch(gatewayUrl, fetchOptions)
      const text = await r.text()

      if (!r.ok) {
        let errorMsg = `Error ${r.status}: ${text || r.statusText}`
        errorMsg += `\n\nRequest: ${httpMethod} ${gatewayUrl}`
        if (r.status === 402) {
          errorMsg += "\n\nPayment required. This endpoint requires x402 payment."
        } else if (r.status === 422) {
          errorMsg += "\n\nValidation error. Check the required payload fields."
        }
        return { content: [{ type: "text", text: errorMsg }], isError: true }
      }

      try {
        const data = JSON.parse(text)
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] }
      } catch {
        return { content: [{ type: "text", text: text }] }
      }
    }

    return {
      content: [{
        type: "text",
        text: `Invalid action '${action}'. Available actions:
- list: Browse available APIs
- inspect: Get API details (requires 'api' param)
- execute: Run an API endpoint (requires 'api', 'path', and optionally 'payload')`
      }],
      isError: true
    }
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true }
  }
})

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch(console.error)
