# MCP1 compatibility verification

The canonical `mcp` runtime retains Ask as its default. The comparison baseline is the preserved MCP1 worktree from 2026-10-23, including its uncommitted embedded-component changes.

| Contract | Verification |
| --- | --- |
| Discovery, selected preparation, quote, approval and saved values | Actual archived MCP1 and current MCP2 were given identical synthetic Gateway responses. Requests and source-card fields matched for both `apk_*` and legacy `aw_*` connections. The new implementation additionally validates input descriptors and refreshes the quote before approval. |
| Embedded results | Recorded MCP1 CBS and UK supplier fixtures are replayed through both MCP Apps and Skybridge. Original component source checksums remain unchanged. |
| Card interactions | Tests exercise source editing, one approval, cancellation, renewed prices, clarification, table paging/filtering/columns, signed PDF/evidence downloads and live-event recovery. |
| Cached clients | Old Ask selection, research, follow-up, task-reference, external-source and execution signatures remain accepted. Compatibility-only names are app-only; 36 model-visible tools still start with Ask. |
| Approval recovery | Old and new approval calls share saved consent. Sequential and concurrent mixed calls authorize once. Unknown outcomes remain explicit and are not reauthorized. A changed quote needs new consent. |
| Planning conflict | Only a definite `request_conflict` on legacy discovery with an explicit request ID gets MCP1's single deterministic planning retry. Timeouts and approval conflicts do not retry. |
| Hosted connections | Canonical server identity/icons, deployment-sensitive versions, server-card metadata, old resource URLs, OAuth discovery, SSE, reconnect challenges and browser connection pages are covered by protocol tests. |

The tests use synthetic transports or recorded result fixtures. They do not purchase provider data. Live local browser checks separately verify connection, source-card loading, inputs and quote review. Installed Claude/Codex host acceptance and production deployment are separate checks.

MCP1 and MCP2 connection-token Ask discovery both use `POST /v2/ask` with the same question. Irrelevant Gateway source rankings can therefore affect both versions; matching the MCP1 contract does not certify every upstream result as correct.
