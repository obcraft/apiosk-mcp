import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
  ListToolsRequestSchema,
  CallToolRequestSchema
} from "@modelcontextprotocol/sdk/types.js"

const APIOSK_BASE = "https://gateway.apiosk.com/apis/v1"

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

const transport = new StdioServerTransport()
await server.connect(transport)
