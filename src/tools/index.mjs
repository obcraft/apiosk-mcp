// The tool registry, and the only place a tool is added.
//
// Eleven tools: six for the single call a buyer approves one of, and five for
// the multi-call plan they approve once and watch afterwards. The second five
// are not a second product — they are the same flow when the answer needs more
// than one call, and they share the price, the approval question and the
// gateway with the first six.
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
import { PLAN_TOOL, runPlan } from "./plan.mjs";
import { EXECUTE_PLAN_TOOL, runExecutePlan } from "./execute-plan.mjs";
import { JOB_STATUS_TOOL, runJobStatus } from "./job-status.mjs";
import { RESOLVE_JOB_TOOL, runResolveJob } from "./resolve-job.mjs";
import { CANCEL_JOB_TOOL, runCancelJob } from "./cancel-job.mjs";

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
  // The plan half of the surface, in the order it runs: plan, approve and
  // start, watch, answer, stop. Every one of them reaches the same gateway
  // routes the app reaches, so a job is one job whichever surface began it.
  { definition: PLAN_TOOL, run: runPlan, requiresConnection: true },
  { definition: EXECUTE_PLAN_TOOL, run: runExecutePlan, requiresConnection: true },
  { definition: JOB_STATUS_TOOL, run: runJobStatus, requiresConnection: true },
  { definition: RESOLVE_JOB_TOOL, run: runResolveJob, requiresConnection: true },
  { definition: CANCEL_JOB_TOOL, run: runCancelJob, requiresConnection: true },
];

export const TOOL_DEFINITIONS = TOOLS.map((tool) => tool.definition);
export const TOOL_NAMES = TOOL_DEFINITIONS.map((tool) => tool.name);

const BY_NAME = new Map(TOOLS.map((tool) => [tool.definition.name, tool]));

export function getTool(name) {
  return BY_NAME.get(name) || null;
}
