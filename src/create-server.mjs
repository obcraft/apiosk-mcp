import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createApioskMcpRuntime, resolveGatewayV2Url } from "./runtime.mjs";
import { V2_INSTRUCTIONS, V2_DESCRIPTION, V2_RESOURCE } from "./gateway-v2.mjs";
import { APIO_V2_CARD_URI, APIO_V2_CHATGPT_CARD_URI, APIO_V2_CARD_LEGACY_URIS, APIO_V2_MODERN_CARD_URIS, gatewayV2CardHtml, gatewayV2CardMeta } from "./gateway-v2-card.mjs";

/**
 * One sentence, defined once.
 *
 * Registries take a server's description from wherever they can find it: the
 * server card, `serverInfo`, or by scraping the HTML at the root. So every one
 * of those surfaces reads this constant, and changing the pitch means changing
 * it in src/gateway-v2.mjs.
 */
export const SERVER_DESCRIPTION = V2_DESCRIPTION;

// Base version, kept in step with the published manifests (package.json etc.).
export const SERVER_BASE_VERSION = "2.0.0";

// The millisecond timestamp encoded in the first 10 chars of a ULID (Crockford
// base32). Fly's FLY_MACHINE_VERSION is a ULID that changes on every deploy, and
// its timestamp is monotonically increasing, which is exactly the "counter"
// property a version needs. Returns null for anything that is not a ULID.
function ulidTimestampMs(ulid) {
  const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const head = String(ulid || "").toUpperCase().slice(0, 10);
  if (head.length < 10) return null;
  let ms = 0;
  for (const ch of head) {
    const v = B32.indexOf(ch);
    if (v < 0) return null;
    ms = ms * 32 + v;
  }
  return ms;
}

// The version a client reads on `initialize`. It must move on every `fly deploy`
// so a client that caches tool definitions can tell it is looking at a new build
// after a redeploy or reconnect. Fly provides no plain release counter, but it
// does set FLY_MACHINE_VERSION (a ULID) which changes each deploy; its timestamp
// (in seconds) becomes the patch, so each deploy reads as a strictly newer
// semver (the patch is respected where build metadata after '+' would be
// ignored). Falls back to the base version locally; APIOSK_MCP_VERSION pins it.
export function resolveServerVersion(env = process.env) {
  const explicit = typeof env.APIOSK_MCP_VERSION === "string" ? env.APIOSK_MCP_VERSION.trim() : "";
  if (explicit) return explicit;
  const [major = "2", minor = "0"] = SERVER_BASE_VERSION.split(".");
  const ms = ulidTimestampMs(env.FLY_MACHINE_VERSION || env.FLY_IMAGE_REF?.split("deployment-")?.[1]);
  return ms ? `${major}.${minor}.${Math.floor(ms / 1000)}` : SERVER_BASE_VERSION;
}

/** Transparent brand mark, shared by initialize and the published server card.
 * SVG follows the host color scheme; PNG fallbacks explicitly name their theme. */
export const SERVER_ICONS = [
  {
    src: "https://mcp.apiosk.com/brand/apiosk-a-20260921.png",
    mimeType: "image/png",
    sizes: ["1254x1254"],
    theme: "light",
  },
  {
    "src": "https://mcp.apiosk.com/brand/mark-20260918.svg",
    "mimeType": "image/svg+xml",
    "sizes": [
      "any"
    ]
  },
  {
    "src": "https://mcp.apiosk.com/brand/mark-light-20260918.png",
    "mimeType": "image/png",
    "sizes": [
      "512x512"
    ],
    "theme": "light"
  },
  {
    "src": "https://mcp.apiosk.com/brand/mark-dark-20260918.png",
    "mimeType": "image/png",
    "sizes": [
      "512x512"
    ],
    "theme": "dark"
  }
];

export const SERVER_INFO = {
  name: "apiosk-mcp",
  version: resolveServerVersion(),
  /**
   * The word a host puts after "from" on its consent card — "Claude wants to
   * use Plan a data request from Apiosk". The tool titles carry the verb, so
   * the server carries only the brand.
   */
  title: "Apiosk",
  description: SERVER_DESCRIPTION,
  websiteUrl: "https://apiosk.com",
  icons: SERVER_ICONS,
};

// Shown to every connecting MCP client/agent as server-level guidance: the
// Gateway v2 host contract, synced from gateway/contracts/host-instructions.md.
export const SERVER_INSTRUCTIONS = V2_INSTRUCTIONS;

function resolveRuntime(options = {}) {
  return options.runtime || createApioskMcpRuntime(options);
}

export async function listApioskTools(options = {}) {
  return resolveRuntime(options).listTools();
}

export function resolveServerPresentation(env = process.env) {
  return {
    info: { ...SERVER_INFO, version: resolveServerVersion(env) },
    description: SERVER_DESCRIPTION,
    instructions: SERVER_INSTRUCTIONS,
  };
}

export function createApioskMcpServer(options = {}) {
  const runtime = resolveRuntime(options);
  const env = options.env || process.env;
  const gatewayUrl = resolveGatewayV2Url(env);
  const cardHtml = gatewayV2CardHtml(gatewayUrl);
  const cardMeta = gatewayV2CardMeta(gatewayUrl);
  const server = new Server(
    resolveServerPresentation(env).info,
    // `prompts` is declared because it is implemented, as an empty list.
    // Leaving it out made prompts/list answer -32601 Method not found, which a
    // scanner reads as a broken server rather than a server without prompts.
    {
      capabilities: { tools: {}, resources: {}, prompts: {} },
      instructions: SERVER_INSTRUCTIONS,
    }
  );

  /**
   * The card, and the one MIME question.
   *
   * MCP Apps (SEP-1865) reads `text/html;profile=mcp-app` and OpenAI's Apps SDK
   * reads `text/html+skybridge`. The current card has a separate, stable URI
   * for each. Only previously issued compatible URIs keep the old
   * host-dependent label: modern ChatGPT also sends an OpenAI user agent, so
   * the user agent is not a MIME signal for the new URIs.
   */
  const legacyMime = () => (options.legacyUiMime ? "text/html+skybridge" : "text/html;profile=mcp-app");
  const cardMime = (uri) => uri.endsWith("-chatgpt.html")
    ? "text/html+skybridge"
    : APIO_V2_MODERN_CARD_URIS.includes(uri) ? "text/html;profile=mcp-app" : legacyMime();

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      V2_RESOURCE,
      { uri: APIO_V2_CARD_URI, name: "Apiosk Gateway v2 interactive card", mimeType: "text/html;profile=mcp-app", _meta: cardMeta },
      { uri: APIO_V2_CHATGPT_CARD_URI, name: "Apiosk card for ChatGPT", mimeType: "text/html+skybridge", _meta: cardMeta },
      ...APIO_V2_CARD_LEGACY_URIS.map((uri) => ({
        uri,
        name: "Apiosk Gateway v2 interactive card (compatible)",
        mimeType: cardMime(uri),
        _meta: cardMeta,
      })),
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    if (uri === V2_RESOURCE.uri) return { contents: [{ uri, mimeType: V2_RESOURCE.mimeType, text: V2_INSTRUCTIONS }] };
    if (uri === APIO_V2_CHATGPT_CARD_URI || APIO_V2_MODERN_CARD_URIS.includes(uri) || APIO_V2_CARD_LEGACY_URIS.includes(uri)) {
      return { contents: [{ uri, mimeType: cardMime(uri), text: cardHtml, _meta: cardMeta }] };
    }
    throw new Error("Unknown Apiosk resource");
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [] }));

  server.setRequestHandler(GetPromptRequestSchema, async () => {
    throw new Error("Use apiosk_discover with your question");
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: await runtime.listTools(),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) =>
    runtime.callTool(request.params.name, request.params.arguments || {}, extra.authInfo)
  );

  return server;
}
