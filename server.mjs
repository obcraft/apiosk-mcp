import express from "express"

const APIOSK_BASE = "https://gateway.apiosk.com/v1/apis"

const SERVER_INFO = {
  name: "apiosk-mcp",
  version: "1.0.0"
}

const TOOLS = [
  {
    name: "apiosk",
    description: "Explore and execute APIs via Apiosk. Use 'list' to see all APIs, 'inspect' to get API details, 'execute' to run an API.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "inspect", "execute"],
          description: "list = get all APIs, inspect = get API details, execute = run an API"
        },
        api: {
          type: "string",
          description: "API identifier (required for inspect and execute)"
        },
        payload: {
          type: "object",
          description: "Request payload for execute action"
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
          description: "Max results to return (for list action, default: all)"
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

async function handleToolCall(name, args) {
  if (name !== "apiosk") {
    return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true }
  }

  const { action, api, payload, limit, offset, search, category } = args || {}

  try {
    if (action === "list") {
      // Build query params
      const params = new URLSearchParams()
      if (limit) params.set("limit", limit)
      if (offset) params.set("offset", offset)
      if (search) params.set("search", search)
      if (category) params.set("category", category)

      // If no limit specified, fetch all APIs
      if (!limit && !offset) {
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

        return { content: [{ type: "text", text: JSON.stringify({ apis: allApis, total: allApis.length }, null, 2) }] }
      }

      const url = params.toString() ? `${APIOSK_BASE}?${params}` : APIOSK_BASE
      const r = await fetch(url)
      const data = await r.json()
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] }
    }

    if (action === "inspect") {
      if (!api) {
        return { content: [{ type: "text", text: "Error: 'api' parameter required for inspect" }], isError: true }
      }
      const r = await fetch(`${APIOSK_BASE}/${api}`)
      const data = await r.json()
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] }
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
      const data = await r.json()
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] }
    }

    return { content: [{ type: "text", text: "Invalid action. Use: list, inspect, or execute" }], isError: true }
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
      return null // No response for notifications

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

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", server: SERVER_INFO })
})

// MCP endpoint
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
      // Notification - no response needed, but send 204
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

// Handle GET for SSE clients (some clients expect this)
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
