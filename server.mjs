import { registerBrandRoutes, BRAND_LINKS } from "./src/brand-routes.mjs";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { fileURLToPath } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  resolveServerPresentation,
  createApioskMcpServer,
  listApioskTools,
} from "./src/create-server.mjs";
import { V2_RESOURCE } from "./src/gateway-v2.mjs";
import { PROMPTS } from "./src/prompts.mjs";
import { APIO_RESULT_CANVAS_URI } from "./src/result-canvas.mjs";
import { APIO_OFFER_CARD_URI } from "./src/offer-card.mjs";
import { APIO_RESULTS_PICKER_URI } from "./src/results-picker.mjs";
import { APIO_CONNECT_CARD_URI } from "./src/connect-card.mjs";
import { APIO_PLAN_CARD_URI } from "./src/plan-card.mjs";
import {
  createHostedOAuthSupport,
  resolveHostedMcpUrls,
} from "./src/oauth.mjs";
import { createApioskMcpRuntime } from "./src/runtime.mjs";
import { openSession, closeSession } from "./src/observability.mjs";
import {
  resolveOpenAiAppsChallengeToken,
  sendOpenAiAppsChallenge,
} from "./well-known.mjs";
import { buildDiscoveryDocument } from "./src/well-known-routes.mjs";
import {
  SETTLEMENT_DISCLOSURE_PATH,
  createSettlementDisclosurePage,
} from "./src/settlement-disclosure.mjs";

const { v2: gatewayV2, info: SERVER_INFO, description: SERVER_DESCRIPTION, instructions: SERVER_INSTRUCTIONS } = resolveServerPresentation();

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
  // Hosted sign-in happens entirely at buy.apiosk.com now (see
  // mcp/01-portal-handoff.md); this server neither renders a sign-in page nor
  // proxies auth routes to the control plane.
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
<title>Apiosk Connect</title>
${BRAND_LINKS}
<style>
  @font-face{font-family:Inter;src:url("/brand/inter-latin-500-normal.woff2") format("woff2");font-weight:500;font-display:swap}@font-face{font-family:Inter;src:url("/brand/inter-latin-600-normal.woff2") format("woff2");font-weight:600;font-display:swap}
  :root{color-scheme:light dark;--bg:#f8f8fb;--card:#fff;--text:#1f2028;--muted:#676371;--border:#e7e3ef;--soft:#f2f1f6;--accent:#6349db;--wash:rgb(99 73 219/.07)}
  @media(prefers-color-scheme:dark){:root{--bg:#0d0f13;--card:#15171d;--text:#ecebf2;--muted:#a5a2b0;--border:#262a34;--soft:#1d2028;--accent:#c3a0ff;--wash:rgb(195 160 255/.12)}}
  *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(760px 340px at 50% -12%,var(--wash),transparent 70%),var(--bg);color:var(--text);font:500 14px/1.5 Inter,ui-sans-serif,system-ui,sans-serif;letter-spacing:-.011em;padding:24px;-webkit-font-smoothing:antialiased}
  main{max-width:560px;width:100%}.card{background:var(--card);border:1px solid var(--border);border-radius:18px;padding:26px;box-shadow:0 18px 45px -38px rgba(72,42,145,.45)}
  .brand{display:block;width:92px;height:30px;margin-bottom:24px}.brand img{display:block;width:92px;height:30px;object-fit:contain;object-position:left center}
  .badge{display:inline-block;font-size:10px;color:var(--muted);border:1px solid var(--border);border-radius:999px;padding:4px 8px;margin-bottom:12px}
  h1{font-size:25px;font-weight:600;line-height:1.18;margin:0 0 8px;letter-spacing:-.032em}p{color:var(--muted);margin:0}.lead{font-size:14px}
  .steps{display:grid;gap:8px;margin:20px 0}.step{display:flex;align-items:center;gap:10px;padding:10px 11px;background:var(--soft);border-radius:11px}.step b{display:grid;place-items:center;width:22px;height:22px;border-radius:7px;background:var(--wash);color:var(--accent);font-size:10px}.step span{font-size:12px}
  h2{font-size:11px;font-weight:600;margin:18px 0 7px}.endpoint{display:block;padding:10px 11px;background:var(--soft);border:1px solid var(--border);border-radius:10px;color:var(--text);word-break:break-all;font:500 11px/1.5 Inter,ui-sans-serif,system-ui,sans-serif}
  details{margin-top:12px;color:var(--muted);font-size:12px}details code{display:block;margin-top:8px;padding:9px 10px;background:var(--soft);border-radius:8px;word-break:break-all}.links{display:flex;gap:15px;flex-wrap:wrap;margin-top:20px;padding-top:16px;border-top:1px solid var(--border)}a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}footer{color:var(--muted);font-size:10px;margin-top:14px}
</style>
</head>
<body>
<main>
  <div class="card">
    <picture class="brand"><source media="(prefers-color-scheme:dark)" srcset="/brand/wordmark-white-320.png"><img src="/brand/wordmark-black-320.png" alt="Apiosk" width="320" height="103"></picture>
    <span class="badge">Model Context Protocol</span>
    <h1>Connect Apiosk to your chatbot</h1>
    <p class="lead">Ask for specialist data, approve the total price in Apiosk and receive the source-backed result in the same conversation.</p>
    <div class="steps"><div class="step"><b>1</b><span>Ask a data question</span></div><div class="step"><b>2</b><span>Review and approve the price</span></div><div class="step"><b>3</b><span>Receive the result and source JSON</span></div></div>

    <h2>Secure MCP endpoint</h2>
    <code class="endpoint">${mcpUrl}</code>
    <details><summary>Manual setup</summary><code>claude mcp add --transport http apiosk ${mcpUrl}</code><code>${mcpUrl.replace(/\/mcp$/, "/sse")}</code></details>

    <div class="links">
      <a href="/health">Health</a>
      <a href="https://dashboard.apiosk.com" target="_blank" rel="noopener">Dashboard</a>
      <a href="https://github.com/obcraft/apiosk-mcp" target="_blank" rel="noopener">Docs &amp; source</a>
    </div>
    <footer>Apiosk Connect &middot; ${SERVER_INFO.name} v${SERVER_INFO.version}</footer>
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
    name: "Apiosk Connect",
    server: SERVER_INFO,
    description: SERVER_DESCRIPTION,
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
const bindHost = process.env.APIOSK_MCP_BIND_HOST || "0.0.0.0";
const app = createMcpExpressApp({ host: bindHost });
// Fly terminates TLS and adds one trusted proxy hop. Without this,
// express-rate-limit rejects X-Forwarded-For and can surface as MCP -32603.
app.set("trust proxy", 1);
const port = Number(process.env.PORT || 3000);
const { issuerUrl, mcpServerUrl } = resolveHostedMcpUrls({
  env: process.env,
  port,
});
const runtime = createApioskMcpRuntime({
  // Hosted MCP is multi-tenant and must never read/write machine-local wallet
  // or config state. Buyer identity and payment capability are request-scoped
  // through OAuth/connect tokens; local wallets belong only to stdio installs.
  enableLocalWallets: false,
  hostedAuthEnabled: true,
});
const hostedOAuth = createHostedOAuthSupport({
  env: process.env,
  issuerUrl,
  mcpServerUrl,
  appName: "Apiosk",
  resourceName: "Apiosk Connect",
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
// buy.apiosk.com's return leg for the portal handoff (mcp/01-portal-handoff.md).
app.get("/authorize/callback", (req, res) => hostedOAuth.handlePortalCallback(req, res));

app.get(OPENAI_APPS_CHALLENGE_PATH_PATTERN, (req, res) => {
  return sendOpenAiAppsChallenge(res, OPENAI_APPS_CHALLENGE_TOKEN);
});

// Public favicon discovery complements MCP initialize metadata for hosts
// that resolve connector branding from the server's origin.
registerBrandRoutes(app);
app.get("/", (req, res) => {
  res.setHeader("cache-control", "public, max-age=0, must-revalidate");
  return sendMcpWelcome(req, res);
});

// Preserve the original URL for already-installed connectors.
app.get("/logo-optimized-light.png", (req, res) => {
  res.setHeader("cache-control", "public, max-age=0, must-revalidate");
  res.type("png").sendFile(fileURLToPath(new URL("./logo-optimized-light.png", import.meta.url)));
});

// Only the declared, versioned brand files are exposed.
for (const icon of SERVER_INFO.icons) {
  const pathname = new URL(icon.src).pathname;
  const filename = pathname.slice("/brand/".length);
  app.get(pathname, (_req, res) => {
    res.setHeader("cache-control", "public, max-age=31536000, immutable");
    res.type(icon.mimeType).sendFile(fileURLToPath(new URL(`./assets/brand/${filename}`, import.meta.url)));
  });
}

// UI resources use the same compact wordmark and self-hosted Inter weights as
// the App. Keep this an explicit allowlist: /brand is not a general file
// server, and adding a packaged asset does not make it public by accident.
for (const asset of [
  { filename: "wordmark-black-320.png", type: "image/png" },
  { filename: "wordmark-white-320.png", type: "image/png" },
  { filename: "inter-latin-500-normal.woff2", type: "font/woff2" },
  { filename: "inter-latin-600-normal.woff2", type: "font/woff2" },
]) {
  app.get(`/brand/${asset.filename}`, (_req, res) => {
    res.setHeader("cache-control", "public, max-age=31536000, immutable");
    res.type(asset.type).sendFile(
      fileURLToPath(new URL(`./assets/brand/${asset.filename}`, import.meta.url))
    );
  });
}

app.get(SETTLEMENT_DISCLOSURE_PATH, (_req, res) => {
  res
    .setHeader("cache-control", "public, max-age=300")
    .type("html")
    .send(createSettlementDisclosurePage());
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

// Static server card (SEP-1649). Lets a registry read this server's identity,
// auth model and capabilities without opening an MCP session.
//
// Built from the SAME runtime that answers tools/list rather than from a
// hand-written literal, because a card that disagrees with the live server is
// worse than no card: a scanner would publish a tool list nobody can call.
//
// `authentication.required` is false and that is the substantive claim here:
// the comparison layer (discover, compare, decide) plus help are served
// pre-auth and spend nothing, so a client can install this and get a real
// answer before authenticating. OAuth only gates publishing and spending.
app.get("/.well-known/mcp/server-card.json", async (req, res) => {
  try {
    const tools = await listApioskTools({ hostedAuthEnabled: true });
    res.setHeader("cache-control", "public, max-age=300");
    res.json({
      serverInfo: SERVER_INFO,
      // Repeated at the top level, not only inside serverInfo. Registries look
      // for these where their own schema puts them, and a scanner that finds
      // nothing publishes a listing with a blank description and a placeholder
      // icon — which is exactly what happened to apiosk/apiosk on first
      // publish. Duplication is cheap; an empty storefront is not.
      name: SERVER_INFO.name,
      title: SERVER_INFO.title,
      description: SERVER_DESCRIPTION,
      version: SERVER_INFO.version,
      websiteUrl: "https://apiosk.com",
      icons: SERVER_INFO.icons,
      instructions: SERVER_INSTRUCTIONS,
      authentication: {
        required: gatewayV2,
        schemes: gatewayV2 ? ["oauth2"] : ["oauth2", "noauth"],
      },
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
        ...(gatewayV2 ? {} : { extensions: { "io.modelcontextprotocol/skills": {} } }),
      },
      tools,
      prompts: gatewayV2 ? [] : PROMPTS,
      // Every card this server can render, not one of the four. A registry
      // reading a card that lists a single resource publishes a connector that
      // looks like it has no interface.
      resources: gatewayV2 ? [V2_RESOURCE] : [
        { uri: APIO_RESULT_CANVAS_URI, name: "Apiosk paid result canvas", mimeType: "text/html+skybridge" },
        { uri: APIO_OFFER_CARD_URI, name: "Apiosk offer approval card", mimeType: "text/html+skybridge" },
        { uri: APIO_RESULTS_PICKER_URI, name: "Apiosk offer picker", mimeType: "text/html+skybridge" },
        { uri: APIO_CONNECT_CARD_URI, name: "Apiosk connection card", mimeType: "text/html+skybridge" },
        { uri: APIO_PLAN_CARD_URI, name: "Apiosk plan approval card", mimeType: "text/html+skybridge" },
      ],
    });
  } catch (error) {
    res.status(500).json({
      error: "server_card_unavailable",
      message: error instanceof Error ? error.message : String(error),
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
// Streamable HTTP for older MCP clients. Current ChatGPT and Claude installs
// should use the preferred /mcp Streamable HTTP endpoint.
const sseTransports = new Map();

app.get("/sse", async (req, res) => {
  const server = createApioskMcpServer({ runtime });
  const transport = new SSEServerTransport("/messages", res);
  sseTransports.set(transport.sessionId, transport);

  // Observability: record the SSE connection (the "who's connected / installs"
  // roster) and mark it closed on disconnect. Fire-and-forget.
  openSession(process.env, {
    sessionId: transport.sessionId,
    transport: "sse",
    ip: req.ip,
    userAgent: req.headers["user-agent"],
  });

  res.on("close", () => {
    sseTransports.delete(transport.sessionId);
    closeSession(process.env, transport.sessionId);
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

app.listen(port, bindHost, async () => {
  console.log(`Apiosk MCP server listening on http://${bindHost}:${port}`);
  console.log(`Health check: http://${bindHost}:${port}/health`);
  console.log(`MCP endpoint: http://${bindHost}:${port}/mcp`);
  console.log(`Legacy SSE endpoint: http://${bindHost}:${port}/sse`);
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
