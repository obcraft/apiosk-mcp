import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  SERVER_INFO,
  createApioskMcpServer,
  listApioskTools,
} from "./src/create-server.mjs";
import { createHostedOAuthSupport, resolveHostedMcpUrls } from "./src/oauth.mjs";
import { createApioskMcpRuntime } from "./src/runtime.mjs";

const CONTROL_PLANE_BACKEND_URL = (
  process.env.APIOSK_CONTROL_PLANE_BACKEND_URL ||
  process.env.APIOSK_DASHBOARD_URL ||
  "https://dashboard.apiosk.com"
).replace(/\/+$/, "");

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
  const normalizedPath = normalizeControlPlanePath(pathname);
  return (
    normalizedPath === "/api/auth/mcp-sign-in" ||
    normalizedPath === "/api/auth/mcp-sign-up" ||
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
  controlPlaneBaseUrl: CONTROL_PLANE_BACKEND_URL,
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
  res.status(405).json({
    jsonrpc: "2.0",
    id: null,
    error: {
      code: -32000,
      message: "Method not allowed.",
    },
  });
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

app.listen(port, "0.0.0.0", async () => {
  console.log(`Apiosk MCP server listening on http://0.0.0.0:${port}`);
  console.log(`Health check: http://0.0.0.0:${port}/health`);
  console.log(`MCP endpoint: http://0.0.0.0:${port}/mcp`);
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
