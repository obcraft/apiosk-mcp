import express from "express"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js"
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js"

const APIOSK_BASE = "https://gateway.apiosk.com/apis/v1"

const server = new Server(
  { name: "apiosk-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_apis",
      description: "List all APIs available on Apiosk. Returns a list of available API slugs and their descriptions.",
      inputSchema: {
        type: "object",
        properties: {},
        required: []
      }
    },
    {
      name: "inspect_api",
      description: "Inspect an API and return endpoint documentation, required parameters, and example payload. Always call this before execute_request to understand the API structure.",
      inputSchema: {
        type: "object",
        properties: {
          api: {
            type: "string",
            description: "The API slug (e.g., 'zeppay-payment-link')"
          }
        },
        required: ["api"]
      }
    },
    {
      name: "execute_request",
      description: "Execute an API request through Apiosk. Use inspect_api first to understand required parameters.",
      inputSchema: {
        type: "object",
        properties: {
          api: {
            type: "string",
            description: "The API slug to execute"
          },
          payload: {
            type: "object",
            description: "The request payload matching the API's required parameters"
          }
        },
        required: ["api"]
      }
    }
  ]
}))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const toolName = req.params.name
  const args = req.params.arguments || {}

  if (toolName === "list_apis") {
    const r = await fetch(APIOSK_BASE)
    const data = await r.json()
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] }
  }

  if (toolName === "inspect_api") {
    const { api } = args
    if (!api) {
      return { content: [{ type: "text", text: "Error: 'api' parameter is required" }] }
    }
    const r = await fetch(`${APIOSK_BASE}/${api}`)
    const data = await r.json()
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] }
  }

  if (toolName === "execute_request") {
    const { api, payload } = args
    if (!api) {
      return { content: [{ type: "text", text: "Error: 'api' parameter is required" }] }
    }
    const r = await fetch(`${APIOSK_BASE}/${api}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {})
    })
    const data = await r.json()
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] }
  }

  return { content: [{ type: "text", text: `Unknown tool: ${toolName}` }] }
})

const app = express()

app.get("/mcp", async (req, res) => {
  const transport = new SSEServerTransport("/mcp", res)
  await server.connect(transport)
})

app.listen(3000, () => {
  console.log("MCP server running on port 3000")
})
