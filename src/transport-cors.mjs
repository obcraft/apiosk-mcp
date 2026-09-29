import cors from "cors";

import { TRANSPORT_RESOURCE_PATHS } from "./oauth.mjs";

/**
 * Cross-origin access to the MCP transports.
 *
 * The OAuth endpoints get this from the SDK's own handlers, which mount
 * `cors()` themselves. The two transports are mounted by hand in server.mjs,
 * so they were the only surfaces answering a browser-side client with no
 * `Access-Control-Allow-Origin` at all — the preflight failed and the request
 * never left the client.
 *
 * WWW-AUTHENTICATE IS THE HEADER THAT MATTERS. A 401 from the transport is not
 * an error, it is the start of the sign-in: it carries the pointer to this
 * server's protected-resource metadata (RFC 9728). A browser hides a response
 * header that is not exposed, so a host that could not read it saw an opaque
 * failure instead of a challenge and reported that it could not connect. The
 * session and protocol headers are exposed for the same reason: the client
 * has to read them back to continue a Streamable HTTP session.
 */
const EXPOSED_HEADERS = ["WWW-Authenticate", "Mcp-Session-Id", "Mcp-Protocol-Version"];

// Requested headers are echoed rather than allowlisted, which is what the
// SDK's OAuth routes already do. The transports are bearer-authenticated and
// never read a cookie, so a wildcard origin grants no ambient authority.
export function registerMcpTransportCors(app) {
  app.use(
    TRANSPORT_RESOURCE_PATHS,
    cors({
      exposedHeaders: EXPOSED_HEADERS,
      methods: ["GET", "POST", "DELETE", "OPTIONS"],
      maxAge: 86400,
    })
  );
}
