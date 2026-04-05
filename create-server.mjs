import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createApioskMcpRuntime } from "./runtime.mjs";

export const SERVER_INFO = {
  name: "apiosk-mcp",
  version: "1.1.0",
};

const runtime = createApioskMcpRuntime();

export async function listApioskTools() {
  return runtime.listTools();
}

export function createApioskMcpServer() {
  const server = new Server(
    SERVER_INFO,
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: await runtime.listTools(),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    return runtime.callTool(request.params.name, request.params.arguments || {});
  });

  return server;
}
