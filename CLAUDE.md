This repository is the Apiosk MCP server, reduced to the buyer flow on
Gateway v2 and nothing else.

Surface rule: bare minimum. Only what a step of the buyer flow needs. Delete
anything else from the repository rather than flagging it off; deleted code
lives in git history. Never add a tool, page, route or module that no task file
asks for.

Since 2.0 there is ONE runtime, Gateway v2 (src/gateway-v2.mjs), for the hosted
server and for stdio alike. src/runtime.mjs only resolves the gateway:
`APIOSK_GATEWAY_V2_URL`, else https://gateway.apiosk.com. The surface is five
tools, defined in src/gateway-v2.mjs:

- apiosk_sources  — GET /v2/sources. Free source browsing, paginated.
- apiosk_discover — POST /v2/discover (or POST /v2/workflows/:slug/start for a
  fixed dossier). One plan, one total price ceiling, or a clarification. No
  purchase.
- apiosk_execute  — POST /v2/execute with a returned next_actions entry.
- apiosk_status   — GET /v2/tasks/:id. Free, read-only recovery and follow-ups.
- apiosk_approve  — POST /v2/approve. App-only: the interactive card calls it
  when the person clicks Approve (context_view.approval_mode = chatbot). The
  model never invokes it. In app mode the person approves at
  proposal.approval_url instead.

MCP has NO planner, NO pricing and NO balance logic of its own: every plan,
price, approval check and execution happens in Gateway v2. OAuth sign-in stays
on the agent gateway (/v1/oauth/*, src/oauth.mjs); its 1.x data routes
(/v1/ask, /v1/select, /v1/plans, /v1/jobs, …) are gone and answer 410.

The tool schemas and host instructions are generated: src/gateway-v2-contracts.json
and src/gateway-v2-instructions.md are copied from gateway/contracts/ by
gateway/scripts/sync-contracts.mjs. Change them there, never here.

test/surface.test.mjs asserts the tool list by name, in order, that the
manifests and versions agree, and fails when any hand-written module in src/
passes 20 KB — anything additive goes in a new file.

Before any deletion commit, tag the parent commit and name the tag in the pull
request. Delete in groups, one commit per group.
