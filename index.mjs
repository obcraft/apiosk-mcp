#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createApioskMcpServer } from "./create-server.mjs";
import { createApioskMcpRuntime } from "./runtime.mjs";

const runtime = createApioskMcpRuntime({ enableLocalWallets: true });
const server = createApioskMcpServer({ runtime });
const transport = new StdioServerTransport();
await server.connect(transport);
