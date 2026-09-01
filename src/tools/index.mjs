// The tool registry, and the only place a tool is added.
//
// Six tools, one per step of the buyer flow plus the one-shot fast path.
//
// Before adding another, read apiosk-buyer-flow-tasks/mcp/00-tool-surface.md.
// The last time this surface was left to grow it reached thirty nine tools with
// five duplicate pairs, and an agent picking from that list picks wrong often
// enough that the product reads as unreliable rather than as broken.

import { CONNECT_TOOL, runConnect } from "./connect.mjs";
import { DISCOVER_TOOL, runDiscoverTool } from "./discover.mjs";
import { COMPARE_TOOL, runCompareTool } from "./compare.mjs";
import { EXECUTE_TOOL, runExecute } from "./execute.mjs";
import { APPROVAL_STATUS_TOOL, runApprovalStatus } from "./approval-status.mjs";
import { QUICK_TOOL, runQuickBest } from "./top.mjs";

/**
 * The surface, in the order the flow runs.
 *
 * `requiresConnection` is what the hosted server checks before it will even
 * dispatch the call (src/oauth.mjs). All provider-data calls use the
 * authenticated App agent gateway, so they start the OAuth handoff here instead
 * of failing later with an opaque upstream 401. `apiosk_connect` remains public
 * because it is the connection diagnostic itself.
 */
export const TOOLS = [
  // Every data call now goes through the authenticated agent gateway. Marking
  // discovery as public made the first /apiosk request fail inside the tool
  // with a plain 401 instead of starting the MCP OAuth handoff.
  { definition: QUICK_TOOL, run: runQuickBest, requiresConnection: true },
  { definition: CONNECT_TOOL, run: runConnect, requiresConnection: false },
  { definition: DISCOVER_TOOL, run: runDiscoverTool, requiresConnection: true },
  { definition: COMPARE_TOOL, run: runCompareTool, requiresConnection: true },
  { definition: EXECUTE_TOOL, run: runExecute, requiresConnection: true },
  { definition: APPROVAL_STATUS_TOOL, run: runApprovalStatus, requiresConnection: true },
];

export const TOOL_DEFINITIONS = TOOLS.map((tool) => tool.definition);
export const TOOL_NAMES = TOOL_DEFINITIONS.map((tool) => tool.name);

const BY_NAME = new Map(TOOLS.map((tool) => [tool.definition.name, tool]));

export function getTool(name) {
  return BY_NAME.get(name) || null;
}
