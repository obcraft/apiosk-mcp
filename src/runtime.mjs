// The runtime: five tools, one client, one dispatch.
//
// This file was 139 KB and held about thirty tool handlers, their schemas, a
// wallet store, a publisher client and four ways to answer "what now". It is
// small now for a reason that is not tidiness: adding a tool has to be a change
// a reviewer cannot miss. A tool is a file in src/tools/ and a line in
// src/tools/index.mjs; nothing can be smuggled in here.
//
// What is left is the part that genuinely belongs to the runtime rather than to
// any one tool: build the gateway client for this request, look the tool up,
// run it, and time and log the call.

import { createGatewayClient } from "./gateway-client.mjs";
import { logToolCall } from "./observability.mjs";
import { TOOL_DEFINITIONS, TOOL_NAMES, getTool } from "./tools/index.mjs";
import { errorContent } from "./tool-result.mjs";

export { TOOL_NAMES };

const DEFAULT_TOOL_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: true,
  properties: {},
};

/**
 * Build the MCP runtime.
 *
 * @param {object} options
 * @param {object} [options.env]            environment, for the gateway base URL and tokens
 * @param {object} [options.client]         a pre-built SDK client, for tests
 * @param {Function} [options.clientFactory] builds the SDK client, for tests
 * @param {Function} [options.fetchImpl]    fetch, for tests
 */
export function createApioskMcpRuntime(options = {}) {
  const env = options.env || process.env;

  // One client per request, not one per process: the connect token that names
  // the buyer's wallet and policy arrives on the request, and one server serves
  // many buyers.
  function gatewayFor(authInfo) {
    return createGatewayClient({
      env,
      authInfo,
      fetchImpl: options.fetchImpl || fetch,
      client: options.client || null,
      clientFactory: options.clientFactory || null,
    });
  }

  // The surface does not vary by caller. An agent that sees a different tool
  // list depending on how it authenticated cannot be reasoned about, and the
  // per-session surfaces this replaced were how thirty nine tools stayed
  // invisible to everyone who could have questioned them.
  async function listTools() {
    return TOOL_DEFINITIONS.map((tool) => ({
      ...tool,
      outputSchema: tool.outputSchema || DEFAULT_TOOL_OUTPUT_SCHEMA,
    }));
  }

  async function dispatchTool(name, argumentsObject, authInfo) {
    const tool = getTool(name);
    if (!tool) {
      return errorContent({
        error_code: "tool.unknown",
        message: `Unknown Apiosk tool: ${name}. This server exposes exactly: ${TOOL_NAMES.join(", ")}.`,
      });
    }

    try {
      return await tool.run(argumentsObject, { env, authInfo, gateway: gatewayFor(authInfo) });
    } catch (error) {
      return errorContent({
        error_code: error?.code || "tool.failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Observability wrapper: time and log every tools/call dispatch. Logging is
  // fire-and-forget — a logging failure never affects the tool result. Raw
  // tokens and arguments are never persisted (hash and key names only).
  async function callTool(name, argumentsObject = {}, authInfo = null) {
    const startedAt = Date.now();
    let outcome = "ok";
    let errorCode = null;
    try {
      const result = await dispatchTool(name, argumentsObject, authInfo);
      if (result?.isError) outcome = "error";
      else if (result?.structuredContent?.status === "payment_required") outcome = "refused";
      else if (result?.structuredContent?.status === "approval_required") outcome = "held";
      return result;
    } catch (error) {
      outcome = "error";
      errorCode = (error && (error.code || error.name)) || null;
      throw error;
    } finally {
      try {
        logToolCall(env, {
          toolName: name,
          outcome,
          errorCode,
          latencyMs: Date.now() - startedAt,
          authInfo,
          argKeys: argumentsObject && typeof argumentsObject === "object" ? Object.keys(argumentsObject) : [],
        });
      } catch {
        /* observability must never break a tool call */
      }
    }
  }

  /**
   * Does this tool need a connection before the server will dispatch it?
   *
   * Read by the hosted OAuth middleware to answer with a 401 challenge rather
   * than letting an unauthenticated call reach a tool that spends money.
   */
  async function isToolProtected(name) {
    return Boolean(getTool(name)?.requiresConnection);
  }

  return { listTools, callTool, isToolProtected };
}
