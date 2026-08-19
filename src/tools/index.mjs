// The tool registry, and the only place a tool is added.
//
// Five tools, one per step of the buyer flow. This file exists so that growing
// the surface is a diff a reviewer cannot miss: a new tool means a new file and
// one line here, not another branch in a 139 KB junk drawer.
//
// Before adding a sixth, read apiosk-buyer-flow-tasks/mcp/00-tool-surface.md.
// The last time this surface was left to grow it reached thirty nine tools with
// five duplicate pairs, and an agent picking from that list picks wrong often
// enough that the product reads as unreliable rather than as broken.

import { CONNECT_TOOL, runConnect } from "./connect.mjs";
import { DISCOVER_TOOL, runDiscoverTool } from "./discover.mjs";
import { COMPARE_TOOL, runCompareTool } from "./compare.mjs";
import { EXECUTE_TOOL, runExecute } from "./execute.mjs";
import { APPROVAL_STATUS_TOOL, runApprovalStatus } from "./approval-status.mjs";

/**
 * The surface, in the order the flow runs.
 *
 * `requiresConnection` is what the hosted server checks before it will even
 * dispatch the call (src/oauth.mjs). It is true for exactly the tools that read
 * or spend a buyer's money. Discovery and comparison stay open: an agent that
 * has to sign in before it can find out whether Apiosk has anything useful will
 * not sign in.
 */
export const TOOLS = [
  { definition: CONNECT_TOOL, run: runConnect, requiresConnection: false },
  { definition: DISCOVER_TOOL, run: runDiscoverTool, requiresConnection: false },
  { definition: COMPARE_TOOL, run: runCompareTool, requiresConnection: false },
  { definition: EXECUTE_TOOL, run: runExecute, requiresConnection: true },
  { definition: APPROVAL_STATUS_TOOL, run: runApprovalStatus, requiresConnection: true },
];

export const TOOL_DEFINITIONS = TOOLS.map((tool) => tool.definition);
export const TOOL_NAMES = TOOL_DEFINITIONS.map((tool) => tool.name);

const BY_NAME = new Map(TOOLS.map((tool) => [tool.definition.name, tool]));

export function getTool(name) {
  return BY_NAME.get(name) || null;
}
