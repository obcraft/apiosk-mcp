import express from "express"

const APIOSK_BASE = "https://gateway.apiosk.com/v1/apis"

const SERVER_INFO = {
  name: "apiosk-mcp",
  version: "1.0.1"
}

const TOOLS = [
  {
    name: "apiosk",
    description: `Apiosk API Gateway - discover and execute paid APIs.

ACTIONS:
1. list - Browse available APIs (returns: id, name, description, price_usd, category, docs_url)
2. inspect - Get full details for a specific API including documentation link
3. execute - Run an API with payload

WORKFLOW:
1. Use 'list' to find APIs (optionally filter by search/category)
2. Use 'inspect' with the API id to get details and docs_url
3. Visit docs_url to understand required payload fields
4. Use 'execute' with api id and payload to call the API`,
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
    const r = await fetch(`${APIOSK_BASE}?limit=${pageSize}&offset=${currentOffset}`)
    const data = await r.json()
    allApis = allApis.concat(data.apis || [])
    if (!data.meta || allApis.length >= data.meta.total) break
    currentOffset += pageSize
  }

  apiCache = allApis
  apiCacheTime = Date.now()
  return allApis
}

async function handleToolCall(name, args) {
  if (name !== "apiosk") {
    return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true }
  }

  const { action, api, payload, limit, offset, search, category } = args || {}

  try {
    if (action === "list") {
      const params = new URLSearchParams()
      params.set("limit", limit || 20)
      if (offset) params.set("offset", offset)
      if (search) params.set("search", search)
      if (category) params.set("category", category)

      const r = await fetch(`${APIOSK_BASE}?${params}`)
      const data = await r.json()

      // Format response with clear next steps
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

      // Find API in list (gateway inspect endpoint is unreliable)
      const allApis = await getApiList()
      const apiInfo = allApis.find(a => a.id === api || a.slug === api)

      if (!apiInfo) {
        return {
          content: [{ type: "text", text: `API '${api}' not found. Use 'list' to see available APIs.` }],
          isError: true
        }
      }

      const result = {
        ...apiInfo,
        how_to_execute: {
          action: "execute",
          api: apiInfo.id,
          payload: "See docs_url for required fields"
        },
        documentation: apiInfo.docs_url,
        gateway_endpoint: apiInfo.gateway_url,
        next_steps: `Visit ${apiInfo.docs_url} to see required payload fields, then use 'execute'.`
      }

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] }
    }

    if (action === "execute") {
      if (!api) {
        return { content: [{ type: "text", text: "Error: 'api' parameter required for execute" }], isError: true }
      }

      const r = await fetch(`${APIOSK_BASE}/${api}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload || {})
      })
      const text = await r.text()

      if (!r.ok) {
        let errorMsg = `Error ${r.status}: ${text || r.statusText}`
        if (r.status === 401 || r.status === 403) {
          errorMsg += "\n\nAuthentication failed. Check that owner_wallet is correct."
        } else if (r.status === 422) {
          errorMsg += "\n\nValidation error. Check docs_url for required payload fields."
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
- execute: Run an API (requires 'api' and 'payload' with 'owner_wallet')`
      }],
      isError: true
    }
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true }
  }
}

function handleMcpRequest(method, params, id) {
  switch (method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          serverInfo: SERVER_INFO,
          capabilities: {
            tools: {}
          }
        }
      }

    case "notifications/initialized":
      return null

    case "tools/list":
      return {
        jsonrpc: "2.0",
        id,
        result: { tools: TOOLS }
      }

    case "tools/call":
      return handleToolCall(params?.name, params?.arguments).then(result => ({
        jsonrpc: "2.0",
        id,
        result
      }))

    case "ping":
      return {
        jsonrpc: "2.0",
        id,
        result: {}
      }

    default:
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32601,
          message: `Method not found: ${method}`
        }
      }
  }
}

const app = express()
app.use(express.json())

app.get("/health", (req, res) => {
  res.json({ status: "ok", server: SERVER_INFO })
})

app.post("/mcp", async (req, res) => {
  const { jsonrpc, id, method, params } = req.body

  if (jsonrpc !== "2.0") {
    return res.status(400).json({
      jsonrpc: "2.0",
      id,
      error: { code: -32600, message: "Invalid Request: must be JSON-RPC 2.0" }
    })
  }

  try {
    const response = await handleMcpRequest(method, params, id)
    if (response === null) {
      return res.status(204).end()
    }
    res.json(response)
  } catch (err) {
    res.status(500).json({
      jsonrpc: "2.0",
      id,
      error: { code: -32603, message: err.message }
    })
  }
})

app.get("/mcp", (req, res) => {
  res.status(405).json({
    error: "Use POST for MCP requests",
    hint: "POST /mcp with JSON-RPC 2.0 body"
  })
})

const PORT = process.env.PORT || 3000
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Apiosk MCP server listening on http://0.0.0.0:${PORT}`)
  console.log(`Health check: http://0.0.0.0:${PORT}/health`)
  console.log(`MCP endpoint: http://0.0.0.0:${PORT}/mcp`)
})
