This repository is being reduced to the Apiosk buyer flow and nothing else.
The plan lives in ../apiosk-buyer-flow-tasks/mcp/.

Surface rule: bare minimum. Only what a step of the buyer flow needs. Delete
anything else from the repository rather than flagging it off; deleted code
lives in git history. Never add a tool, page, route or module that no task file
asks for.

The surface is eleven tools, in two groups.

Single call — one endpoint, one price, one purchase: apiosk_connect, apiosk,
apiosk_discover, apiosk_compare, apiosk_execute, apiosk_approval_status.
`apiosk` is the short path: it returns the App-ranked top runnable provider,
exact buyer price and an Approve/Deny card; it never spends. These six are the
original surface and existing clients depend on them unchanged — in particular
`apiosk_execute` and its `offer_token`.

Plan and job — a goal that takes several calls, approved once, run durably:
apiosk_plan, apiosk_execute_plan, apiosk_job_status, apiosk_resolve_job,
apiosk_cancel_job. Added by step 7 of
tasks/goal-plan-price-result/. MCP has NO planner and NO balance logic of its
own: every plan, every price and every job comes from the gateway's `/v1/plans`
and `/v1/jobs` routes, which is what lets the App and an MCP client show the
same plan hash and the same amount. `apiosk_plan` spends nothing;
`apiosk_execute_plan` accepts only an already-approved `plan_token` and cannot
construct or change a plan.

A tool is a file in src/tools/ and one line in src/tools/index.mjs.
test/surface.test.mjs asserts the list by name, in order, and fails when any
hand-written module in src/ passes 20 KB — src/discovery.mjs is 77 bytes under
that cap, so anything additive goes in a new file.

Before any deletion commit, tag the parent commit and name the tag in the pull
request. Delete in groups, one commit per group.
