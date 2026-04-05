import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  SERVER_INFO,
  createApioskMcpServer,
  listApioskTools,
} from "./create-server.mjs";
import { createApioskMcpRuntime } from "./runtime.mjs";

// Public Fly deployment must accept the Fly hostname instead of localhost-only
// host validation defaults.
const app = createMcpExpressApp({ host: "0.0.0.0" });
const runtime = createApioskMcpRuntime({
  enableLocalWallets: process.env.APIOSK_ENABLE_LOCAL_WALLETS === "true",
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

app.post("/mcp", async (req, res) => {
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

const port = Number(process.env.PORT || 3000);
app.listen(port, "0.0.0.0", async () => {
  console.log(`Apiosk MCP server listening on http://0.0.0.0:${port}`);
  console.log(`Health check: http://0.0.0.0:${port}/health`);
  console.log(`MCP endpoint: http://0.0.0.0:${port}/mcp`);
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
