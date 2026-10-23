# Ask functionality in the MCP

The MCP exposes the Ask data workflow through its tools and interactive card.
The host retains chat history, file reading, other app actions and scheduling.

| Operation | MCP interface | Purchase behavior |
| --- | --- | --- |
| Search a question of up to 16,000 characters | `apiosk_ask {question}` | No task or purchase |
| Retry both source origins with the same interpretation | `apiosk_ask {question, refresh:{parsed_request,search_id}}` | No new parse or purchase |
| Choose native sources and fill declared inputs | `apiosk_ask` signed `selections` | One saved manual quote |
| Combine native and Bazaar sources | Card selection basket | One displayed sum and one click; exact quotes and outcomes remain saved separately |
| Plan the full displayed question | `apiosk_ask {question,research:{parsed_request,search_id,discovery_id?}}` | Reuses signed search; manual approval |
| Continue a question on bought data | `apiosk_ask {question,task_refs}` | Saved answer, clarification or new-search decision; no purchase |
| Read native saved evidence and charges | `apiosk_status {task_ref}` | Read only |
| Inspect, prepare or read a Bazaar source | `apiosk_external` actions `source`, `prepare`, `status` | Preparation never buys; status never reexecutes |
| Approve native or external quotes | Private card tools | Exact saved quote and ceiling; no approval from model text |
| Refresh an expired native quote | Private `apiosk_requote` | Manual approval remains required |

Both MCP Apps and ChatGPT cards use the same rendered controls. Typed inputs
preserve booleans, numbers, enums and structured values. A restored card reads
saved status before permitting ambiguous approvals to be retried. Missing
requirements, unavailable searches and truncated results stay explicit.

Deploy the Gateway changes before the MCP changes. New routes include
`/v2/ask/search`, `/v2/ask/research`, `/v2/ask/conversation` and the connected
`/v2/ask/external/*` adapters. Existing App routes retain their auth guards.
Refresh the host's tool catalog after deployment to expose the new arguments
and Bazaar tools. Local tests do not prove deployed host behavior or a real
provider purchase.

## SerpApi web context

The Gateway's subject web context is shared by Ask and MCP. Set
`SERPAPI_API_KEY` in the Gateway environment, never in the browser or MCP tool
arguments. `ASK_WEB_SEARCH_PROVIDER=auto` selects SerpApi when a key is present;
`serpapi` explicitly selects it, and `public` uses the original public searches.
Restart the Gateway after changing its environment.

SerpApi sends one Google search per uncached subject, at most four subjects per
question. Successful context is cached for 15 minutes and concurrent requests
are coalesced. Each SerpApi request has an eight-second timeout and no automatic
retry. On failure, public searches remain available. Publisher URLs, snippets,
provider names and returned dates remain source data; public web context is not
verified registry or sanctions evidence. SerpApi usage is an operator cost and
does not alter the buyer price, approval or ledger.

Reference: [Google Search API](https://serpapi.com/search-api) and
[organic result fields](https://serpapi.com/organic-results).

## Verification on 2026-10-23

- Full MCP suite: 283 passed, including both card transports, actual widget
  restoration, mixed quotes, uncertain approval recovery and read-only
  automatic status updates.
- Fresh Gateway library build, serial test run: 1,116 passed, 30 ignored,
  one known baseline test excluded. The excluded capability-intake correction
  test also fails on pristine HEAD `d1faea6516b21bf8c72de4cf31cd17cb4587aac3`
  (expected three model requests, received two). An initial parallel run also
  hit a telemetry assertion; the fresh serial run passed that test.
- Isolated database/HTTP fixtures verified connected signed refresh/research,
  saved-answer continuation, native name lookup prerequisites and external
  approval. They prove manual approval, ownership, idempotency and saved reads
  without real provider purchases.
- The existing App research fixture (`needs_input` versus `ready`) also fails
  on pristine HEAD; the App source tree was not edited.
- One explicitly enabled live SerpApi test passed through the new Rust adapter.
  Other provider tests used fixtures; this does not establish production
  deployment or installed Claude/ChatGPT acceptance.
- Graphify AST index refreshed and both repository diffs pass whitespace checks.

Production deployment is separate from these implementation checks. Deploy
Gateway first, configure its SerpApi secret, then deploy MCP and verify the live
tool catalog and card resources. Installed hosts must refresh their tool
catalog. The SerpApi key belongs only in ignored local configuration and the
Gateway's encrypted production secrets, never in source or test artifacts.
