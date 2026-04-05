#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createApioskMcpServer } from "./create-server.mjs";

const server = createApioskMcpServer();
const transport = new StdioServerTransport();
await server.connect(transport);
