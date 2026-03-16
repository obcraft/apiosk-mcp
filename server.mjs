import express from "express"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import {
  ListToolsRequestSchema,
  CallToolRequestSchema
} from "@modelcontextprotocol/sdk/types.js"
import express from "express"

const APIOSK_BASE = "https://gateway.apiosk.com/v1/apis"

function createServer() {
  const server = new Server(
    { name: "apiosk-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } }
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "apiosk",
        description: "Explore and execute APIs via Apiosk",
        inputSchema: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["list","inspect","execute"]
            },
            api: { type: "string" },
            payload: { type: "object" }
          },
          required: ["action"]
        }
      }
    ]
  }))

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { action, api, payload } = req.params.arguments

    if (action === "list") {
      const r = await fetch(APIOSK_BASE)
      return { content: [{ type: "text", text: JSON.stringify(await r.json(), null, 2) }] }
    }

    if (action === "inspect") {
      const r = await fetch(`${APIOSK_BASE}/${api}`)
      return { content: [{ type: "text", text: JSON.stringify(await r.json(), null, 2) }] }
    }

    if (action === "execute") {
      const r = await fetch(`${APIOSK_BASE}/${api}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload || {})
      })
      return { content: [{ type: "text", text: JSON.stringify(await r.json(), null, 2) }] }
    }

    return { content: [{ type: "text", text: "Invalid action" }] }
  })

  return server
}

const app = express()
app.use(express.json())

app.all("/mcp", async (req, res) => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  const server = createServer()
  await server.connect(transport)
  await transport.handleRequest(req, res, req.body)
  res.on("finish", () => server.close())
})

const PORT = process.env.PORT || 3000
app.listen(PORT, "0.0.0.0", () => {
  console.log(`MCP server listening on 0.0.0.0:${PORT}`)
})
