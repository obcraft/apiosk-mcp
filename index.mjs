#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
  ListToolsRequestSchema,
  CallToolRequestSchema
} from "@modelcontextprotocol/sdk/types.js"

// Use remote server if APIOSK_REMOTE is set, otherwise call gateway directly
const APIOSK_BASE = process.env.APIOSK_BASE || "https://gateway.apiosk.com/v1/apis"

const server = new Server(
  { name: "apiosk-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
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
}))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { action, api, payload, limit, offset, search, category } = req.params.arguments || {}

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
})

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch(console.error)
