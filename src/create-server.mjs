import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createApioskMcpRuntime } from "./runtime.mjs";

export const SERVER_INFO = {
  name: "apiosk-mcp",
  version: "1.3.2",
};

function resolveRuntime(options = {}) {
  return options.runtime || createApioskMcpRuntime(options);
}

export async function listApioskTools(options = {}) {
  return resolveRuntime(options).listTools(options.authInfo);
}

export function createApioskMcpServer(options = {}) {
  const runtime = resolveRuntime(options);
  const server = new Server(
    SERVER_INFO,
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => ({
    tools: await runtime.listTools(extra.authInfo),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    return runtime.callTool(request.params.name, request.params.arguments || {}, extra.authInfo);
  });

  return server;
}
