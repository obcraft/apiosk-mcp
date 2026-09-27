#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createApioskMcpServer } from "./src/create-server.mjs";
import { createApioskMcpRuntime } from "./src/runtime.mjs";

// Gateway v2 (https://gateway.apiosk.com unless APIOSK_GATEWAY_V2_URL says
// otherwise), authenticated with the agent token in APIOSK_CONNECT_TOKEN.
const runtime = createApioskMcpRuntime();
const server = createApioskMcpServer({ runtime });
const transport = new StdioServerTransport();
await server.connect(transport);
