import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  SERVER_INFO,
  createApioskMcpServer,
  listApioskTools,
} from "./src/create-server.mjs";
import {
  createHostedOAuthSupport,
  createMcpWalletAuthNonce,
  resolveHostedMcpUrls,
} from "./src/oauth.mjs";
import { createApioskMcpRuntime } from "./src/runtime.mjs";
import {
  resolveOpenAiAppsChallengeToken,
  sendOpenAiAppsChallenge,
} from "./well-known.mjs";
import {
  buildDiscoveryDocument,
  getOpenApiRouteDocument,
} from "./src/publisher.mjs";

const CONTROL_PLANE_BACKEND_URL = (
  process.env.APIOSK_CONTROL_PLANE_BACKEND_URL ||
  process.env.APIOSK_DASHBOARD_URL ||
  "https://dashboard.apiosk.com"
).replace(/\/+$/, "");
const OPENAI_APPS_CHALLENGE_TOKEN = resolveOpenAiAppsChallengeToken(process.env);
const OPENAI_APPS_CHALLENGE_PATH_PATTERN =
  /^\/\.well-known\/openai-apps-challenge(?:\/\.well-known\/openai-apps-challenge)*\/?$/;

function normalizeControlPlanePath(pathname = "") {
  const basePath = String(pathname || "")
    .split("?")[0]
    .replace(/\/+$/, "");

  if (!basePath) {
    return "/";
  }

  if (basePath === "/api") {
    return "/api";
  }

  if (basePath.startsWith("/api/")) {
    return basePath;
  }

  if (basePath.startsWith("/")) {
    return `/api${basePath}`;
  }

  return `/api/${basePath}`;
}

function shouldProxyControlPlanePath(pathname = "") {
  // Hosted sign-in is wallet-only now (see src/oauth.mjs); the email/password
  // /api/auth/mcp-sign-in|sign-up routes never existed on the control plane, so
  // they are no longer proxied.
  const normalizedPath = normalizeControlPlanePath(pathname);
  return (
    normalizedPath.startsWith("/api/credits/") ||
    normalizedPath === "/api/agent-wallets" ||
    normalizedPath.startsWith("/api/agent-wallets/")
  );
}

async function proxyControlPlaneRequest(req, res) {
  const targetUrl = new URL(req.originalUrl || req.url || "/", CONTROL_PLANE_BACKEND_URL);
  const headers = new Headers();

  for (const [key, value] of Object.entries(req.headers || {})) {
    if (value == null) continue;
    if (["host", "content-length", "connection"].includes(key.toLowerCase())) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else {
      headers.set(key, value);
    }
  }

  let body = undefined;
  if (!["GET", "HEAD"].includes(req.method.toUpperCase())) {
    if (typeof req.body === "string") {
      body = req.body;
    } else if (req.body !== undefined && req.body !== null) {
      headers.set("content-type", headers.get("content-type") || "application/json");
      body = JSON.stringify(req.body);
    }
  }

  const response = await fetch(targetUrl, {
    method: req.method,
    headers,
    body,
    redirect: "manual",
  });

  res.status(response.status);
  response.headers.forEach((value, key) => {
    if (["content-encoding", "transfer-encoding", "connection"].includes(key.toLowerCase())) return;
    res.setHeader(key, value);
  });

  const text = await response.text();
  res.send(text);
}

function resolvePublicMcpUrl(req) {
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const proto = forwardedProto || req.protocol || "https";
  const host = req.headers.host || "mcp.apiosk.com";
  return `${proto}://${host}/mcp`;
}

function renderMcpWelcomeHtml(mcpUrl) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>Apiosk MCP</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: radial-gradient(1200px 600px at 50% -10%, #1b2230, #0b0e14 60%);
    color: #e6e9ef; font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    padding: 32px;
  }
  main { max-width: 640px; width: 100%; }
  .badge {
    display: inline-block; font-size: 12px; letter-spacing: .08em; text-transform: uppercase;
    color: #8aa0c6; border: 1px solid #2a3344; border-radius: 999px; padding: 4px 12px; margin-bottom: 20px;
  }
  h1 { font-size: 30px; margin: 0 0 12px; letter-spacing: -.02em; }
  p { color: #b8c0cf; margin: 0 0 16px; }
  .lead { color: #d6dce6; font-size: 17px; }
  ul { color: #b8c0cf; margin: 0 0 16px; padding-left: 20px; }
  li { margin: 6px 0; }
  code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px;
    background: #141a24; border: 1px solid #232c3a; border-radius: 6px; padding: 2px 7px; color: #cfe0ff;
  }
  .card { background: #0f141c; border: 1px solid #1f2937; border-radius: 14px; padding: 28px 30px; }
  .endpoint {
    display: block; margin: 4px 0 20px; padding: 12px 14px; background: #141a24;
    border: 1px solid #232c3a; border-radius: 8px; color: #cfe0ff; word-break: break-all;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px;
  }
  h2 { font-size: 13px; letter-spacing: .06em; text-transform: uppercase; color: #7f8aa0; margin: 24px 0 8px; }
  a { color: #7aa2ff; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .links { display: flex; gap: 18px; flex-wrap: wrap; margin-top: 18px; padding-top: 18px; border-top: 1px solid #1f2937; }
  footer { color: #6b7689; font-size: 12px; margin-top: 20px; }
</style>
</head>
<body>
<main>
  <div class="card">
    <span class="badge">Model Context Protocol</span>
    <h1>Welcome to Apiosk MCP</h1>
    <p class="lead">
      This is the Apiosk MCP server endpoint &mdash; it lets AI agents discover, pay for,
      execute, and publish APIs through the Apiosk gateway. It is a machine endpoint, not a
      website, so connect it from an MCP client (Claude, Cursor, ChatGPT, and others) rather
      than browsing it here.
    </p>

    <h2>What you can do with it</h2>
    <ul>
      <li><strong>Discover</strong> APIs, datasets, and services in the Apiosk catalog.</li>
      <li><strong>Pay</strong> per call automatically in USDC (x402 on Base).</li>
      <li><strong>Execute</strong> any listing through a uniform contract or its API-specific tool.</li>
      <li><strong>Publish &amp; manage</strong> your own APIs so other agents can find and pay for them.</li>
      <li><strong>Ship paid x402 routes from a coding agent</strong> &mdash; connect with
        <code>Authorization: Bearer sk_live_&hellip;</code> (a provider API key) and use
        <code>publish_x402_route</code>, <code>test_x402_route</code>, and friends.</li>
    </ul>

    <h2>Endpoint</h2>
    <code class="endpoint">${mcpUrl}</code>

    <h2>Connect from Claude Code</h2>
    <code>claude mcp add --transport http apiosk ${mcpUrl}</code>

    <h2>Connect from ChatGPT (legacy SSE)</h2>
    <code class="endpoint">${mcpUrl.replace(/\/mcp$/, "/sse")}</code>

    <div class="links">
      <a href="/health">Health</a>
      <a href="https://dashboard.apiosk.com" target="_blank" rel="noopener">Dashboard</a>
      <a href="https://github.com/obcraft/apiosk-mcp" target="_blank" rel="noopener">Docs &amp; source</a>
    </div>
    <footer>Apiosk MCP &middot; ${SERVER_INFO.name} v${SERVER_INFO.version}</footer>
  </div>
</main>
</body>
</html>`;
}

// Browsers (Accept: text/html) get a friendly welcome page; other non-protocol
// callers get a JSON welcome. MCP protocol clients (Accept: text/event-stream)
// are handled separately with the spec-compliant 405.
function sendMcpWelcome(req, res) {
  const mcpUrl = resolvePublicMcpUrl(req);
  const accept = String(req.headers.accept || "");

  if (accept.includes("text/html")) {
    res.status(200).type("html").send(renderMcpWelcomeHtml(mcpUrl));
    return;
  }

  res.status(200).json({
    name: "Apiosk MCP",
    server: SERVER_INFO,
    description:
      "Apiosk MCP server endpoint. Connect it from an MCP client to discover, pay for, execute, and publish APIs through the Apiosk gateway.",
    transport: "streamable-http",
    endpoint: mcpUrl,
    legacy_sse_endpoint: mcpUrl.replace(/\/mcp$/, "/sse"),
    connect: {
      claude_code: `claude mcp add --transport http apiosk ${mcpUrl}`,
    },
    docs: "https://github.com/obcraft/apiosk-mcp",
    health: "/health",
  });
}

// Public Fly deployment must accept the Fly hostname instead of localhost-only
// host validation defaults.
const app = createMcpExpressApp({ host: "0.0.0.0" });
const port = Number(process.env.PORT || 3000);
const { issuerUrl, mcpServerUrl } = resolveHostedMcpUrls({
  env: process.env,
  port,
});
const runtime = createApioskMcpRuntime({
  enableLocalWallets: process.env.APIOSK_ENABLE_LOCAL_WALLETS === "true",
  hostedAuthEnabled: true,
});
const hostedOAuth = createHostedOAuthSupport({
  env: process.env,
  issuerUrl,
  mcpServerUrl,
  appName: "Apiosk",
  resourceName: "Apiosk MCP",
});
const mcpAuthMiddleware = hostedOAuth.createMcpAuthMiddleware(runtime);

app.use(hostedOAuth.metadataRouter);
app.use(new URL(hostedOAuth.oauthMetadata.authorization_endpoint).pathname, hostedOAuth.authorizationRouter);
app.use(new URL(hostedOAuth.oauthMetadata.token_endpoint).pathname, hostedOAuth.tokenRouter);
if (hostedOAuth.oauthMetadata.registration_endpoint) {
  app.use(
    new URL(hostedOAuth.oauthMetadata.registration_endpoint).pathname,
    hostedOAuth.registrationRouter
  );
}

app.get(OPENAI_APPS_CHALLENGE_PATH_PATTERN, (req, res) => {
  return sendOpenAiAppsChallenge(res, OPENAI_APPS_CHALLENGE_TOKEN);
});

// Self-hosted browser bundle for the /authorize Create-wallet flow (viem
// generateMnemonic/mnemonicToAccount). Served same-origin because some
// embedded browsers refuse cross-origin dynamic module imports, which would
// silently break wallet creation if we pulled this from a CDN. Regenerate
// with scripts/build-wallet-lib.mjs after a viem upgrade.
let walletAccountsBundle = null;
app.get("/assets/wallet-accounts.mjs", async (req, res) => {
  try {
    if (!walletAccountsBundle) {
      const { readFile } = await import("node:fs/promises");
      const bundleUrl = new URL("./src/assets/wallet-accounts.mjs", import.meta.url);
      walletAccountsBundle = await readFile(bundleUrl);
    }
    res.setHeader("content-type", "text/javascript; charset=utf-8");
    res.setHeader("cache-control", "public, max-age=3600");
    res.send(walletAccountsBundle);
  } catch (error) {
    res.status(404).json({
      error: "not_found",
      message: "Wallet library bundle is not available on this deployment.",
      status: 404,
    });
  }
});

app.post("/api/auth/mcp-wallet-nonce", async (req, res) => {
  try {
    const nonce = await createMcpWalletAuthNonce({ env: process.env });
    res.status(200).json(nonce);
  } catch (error) {
    const status = Number.isFinite(error?.status) ? error.status : 502;
    res.status(status).json({
      error: "wallet_auth_unavailable",
      message:
        error instanceof Error
          ? error.message
          : "Wallet sign-in is temporarily unavailable.",
      status,
    });
  }
});

app.all("/api/*path", async (req, res) => {
  try {
    const pathname = req.path || req.originalUrl || "";
    if (!shouldProxyControlPlanePath(pathname)) {
      return res.status(404).json({
        error: "not_found",
        message: "Unknown MCP control-plane route.",
        status: 404,
      });
    }

    await proxyControlPlaneRequest(req, res);
  } catch (error) {
    res.status(502).json({
      error: "bad_gateway",
      message: error instanceof Error ? error.message : String(error),
      status: 502,
    });
  }
});

// Hosted OpenAPI spec for a published x402 route (generate_openapi_spec
// returns this URL). Built live from the gateway database, so it always
// reflects the current listing. Accepts /openapi/<route_id> and
// /openapi/<route_id>.json.
app.get("/openapi/:routeId", async (req, res) => {
  try {
    const document = await getOpenApiRouteDocument(req.params.routeId, {
      env: process.env,
    });
    if (!document) {
      return res.status(404).json({
        error: "not_found",
        message: "No published route matches this id.",
        status: 404,
      });
    }
    res.setHeader("cache-control", "public, max-age=60");
    res.json(document);
  } catch (error) {
    res.status(502).json({
      error: "bad_gateway",
      message: error instanceof Error ? error.message : String(error),
      status: 502,
    });
  }
});

// Machine-readable index of every paid x402 route published through Apiosk,
// reshaped from the gateway's /.well-known/x402 document (60s cache).
app.get(["/.well-known/apiosk-routes.json", "/discovery"], async (req, res) => {
  try {
    const document = await buildDiscoveryDocument({ env: process.env });
    res.setHeader("cache-control", "public, max-age=60");
    res.json(document);
  } catch (error) {
    res.status(502).json({
      error: "bad_gateway",
      message: error instanceof Error ? error.message : String(error),
      status: 502,
    });
  }
});

app.get("/health", async (req, res) => {
  try {
    const tools = await listApioskTools({ runtime });
    res.json({
      status: "ok",
      server: SERVER_INFO,
      tool_count: tools.length,
    });
  } catch (error) {
    res.status(503).json({
      status: "degraded",
      server: SERVER_INFO,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.post("/mcp", mcpAuthMiddleware, async (req, res) => {
  const server = createApioskMcpServer({ runtime });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);

    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
  } catch (error) {
    console.error("Error handling MCP request:", error);

    if (!res.headersSent) {
      return res.status(500).json({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  } finally {
    if (res.writableEnded) {
      await transport.close().catch(() => {});
      await server.close().catch(() => {});
    }
  }
});

app.get("/mcp", (req, res) => {
  const accept = String(req.headers.accept || "");

  // MCP Streamable HTTP clients open the optional SSE stream via a GET with
  // Accept: text/event-stream. This stateless server does not provide that
  // stream, so keep the spec-compliant 405 for protocol clients.
  if (accept.includes("text/event-stream")) {
    return res.status(405).json({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32000,
        message: "Method not allowed.",
      },
    });
  }

  // Humans navigating here in a browser (or curling the URL) get a welcome.
  return sendMcpWelcome(req, res);
});

app.delete("/mcp", (req, res) => {
  res.status(405).json({
    jsonrpc: "2.0",
    id: null,
    error: {
      code: -32000,
      message: "Method not allowed.",
    },
  });
});

// Legacy HTTP+SSE transport (protocol version 2024-11-05), kept alongside
// Streamable HTTP for clients that only speak the older transport (e.g.
// ChatGPT's MCP connector, which opens a GET /sse stream and posts messages
// to /messages?sessionId=...).
const sseTransports = new Map();

app.get("/sse", async (req, res) => {
  const server = createApioskMcpServer({ runtime });
  const transport = new SSEServerTransport("/messages", res);
  sseTransports.set(transport.sessionId, transport);

  res.on("close", () => {
    sseTransports.delete(transport.sessionId);
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });

  try {
    await server.connect(transport);
  } catch (error) {
    console.error("Error establishing /sse stream:", error);
    sseTransports.delete(transport.sessionId);
  }
});

app.post("/messages", mcpAuthMiddleware, async (req, res) => {
  const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : "";
  const transport = sseTransports.get(sessionId);

  if (!transport) {
    res.status(400).json({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32000,
        message: "Bad Request: No SSE session found for the given sessionId.",
      },
    });
    return;
  }

  try {
    await transport.handlePostMessage(req, res, req.body);
  } catch (error) {
    console.error("Error handling /messages request:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }
});

app.listen(port, "0.0.0.0", async () => {
  console.log(`Apiosk MCP server listening on http://0.0.0.0:${port}`);
  console.log(`Health check: http://0.0.0.0:${port}/health`);
  console.log(`MCP endpoint: http://0.0.0.0:${port}/mcp`);
  console.log(`Legacy SSE endpoint: http://0.0.0.0:${port}/sse`);
  console.log(`OAuth issuer: ${issuerUrl.href}`);
  console.log(`OAuth protected-resource metadata: ${hostedOAuth.resourceMetadataUrl}`);
  try {
    const tools = await listApioskTools({ runtime });
    console.log(`Loaded ${tools.length} tools from the Apiosk catalog.`);
  } catch (error) {
    console.warn(
      `Unable to prefetch Apiosk catalog on startup: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
});
