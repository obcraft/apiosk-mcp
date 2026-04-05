import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createApioskMcpRuntime } from "./runtime.mjs";

export const SERVER_INFO = {
  name: "apiosk-mcp",
  version: "1.2.0",
};

function resolveRuntime(options = {}) {
  return options.runtime || createApioskMcpRuntime(options);
}

export async function listApioskTools(options = {}) {
  return resolveRuntime(options).listTools();
}

export function createApioskMcpServer(options = {}) {
  const runtime = resolveRuntime(options);
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
