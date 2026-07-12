import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createApioskMcpRuntime } from "./runtime.mjs";
import { APIO_RESULT_CANVAS_HTML, APIO_RESULT_CANVAS_URI } from "./result-canvas.mjs";

export const SERVER_INFO = {
  name: "apiosk-mcp",
  version: "1.4.4",
  title: "Apiosk Connect",
};

// Shown to every connecting MCP client/agent as server-level guidance.
export const SERVER_INSTRUCTIONS = `Apiosk is a pay-per-call API marketplace for AI agents. Every listed API is callable through the Apiosk gateway (https://gateway.apiosk.com) and priced per request in USDC via the x402 payment protocol (402 Payment Required -> pay -> retry).

Two roles, two workflows:

BUYERS (call paid APIs):
1. apiosk_search / apiosk_explore: find APIs in the catalog (weather, finance, crypto, geo, scraping, verification, and more).
2. apiosk_get_api: inspect pricing, endpoints, and input/output schemas for a slug.
3. apiosk_execute: call any listing through one uniform envelope; payment settles automatically when a wallet or connect token is configured.
Auth options: x402 wallet (APIOSK_PRIVATE_KEY), an aw_ connect token from the buyer dashboard, or OAuth sign-in on the hosted server.

PROVIDERS (publish paid APIs):
Authenticate with a provider API key: header "Authorization: Bearer sk_live_..." (minted in the provider portal under Settings, API keys).
1. publish_x402_route: turn any HTTPS endpoint into a paid x402 route (name, upstream_url, price in USDC, settlement_address). New routes enter operator review (status pending_review), then go live, appear in https://gateway.apiosk.com/.well-known/x402, and are auto-indexed in the Coinbase x402 Bazaar.
2. publish_project: publish several routes of one project in a single call.
3. list_x402_routes / update_x402_route / unpublish_x402_route: manage routes.
4. test_x402_route: verify a route returns a correct 402 payment offer.
5. generate_openapi_spec: host an OpenAPI 3.1 spec at https://mcp.apiosk.com/openapi/<route_id>.json.
Settlement: 98% of every paid call goes to the provider's settlement address; Apiosk keeps a 2% platform fee.

Machine-readable discovery: https://mcp.apiosk.com/.well-known/apiosk-routes.json (alias /discovery) lists every paid route; https://gateway.apiosk.com/.well-known/x402 is the canonical x402 discovery document. Docs: https://docs.apiosk.com`;

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
    { capabilities: { tools: {}, resources: {} }, instructions: SERVER_INSTRUCTIONS }
  );

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [{ uri: APIO_RESULT_CANVAS_URI, name: "Apiosk paid result canvas", mimeType: "text/html+skybridge" }],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    if (request.params.uri !== APIO_RESULT_CANVAS_URI) throw new Error("Unknown Apiosk resource");
    return { contents: [{ uri: APIO_RESULT_CANVAS_URI, mimeType: "text/html+skybridge", text: APIO_RESULT_CANVAS_HTML }] };
  });

  server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => ({
    tools: await runtime.listTools(extra.authInfo),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    return runtime.callTool(request.params.name, request.params.arguments || {}, extra.authInfo);
  });

  return server;
}
