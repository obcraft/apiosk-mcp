This repository is being reduced to the Apiosk buyer flow and nothing else.
The plan lives in ../apiosk-buyer-flow-tasks/mcp/.

Surface rule: bare minimum. Only what a step of the buyer flow needs. Delete
anything else from the repository rather than flagging it off; deleted code
lives in git history. Never add a tool, page, route or module that no task file
asks for.

The surface is six tools: apiosk_connect, apiosk, apiosk_discover,
apiosk_compare, apiosk_execute, apiosk_approval_status. `apiosk` is the short
path: it returns the App-ranked top runnable provider, exact buyer price and an
Approve/Deny card; it never spends. A tool is a file in src/tools/ and one line
in src/tools/index.mjs. test/surface.test.mjs asserts the list by name and fails
when any hand-written module in src/ passes 20 KB.

Before any deletion commit, tag the parent commit and name the tag in the pull
request. Delete in groups, one commit per group.
