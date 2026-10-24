# Apiosk MCP

`@apiosk/mcp` 3.0.0 brings the Apiosk **Ask** workflow to Claude, Codex and other MCP hosts: ask a question, compare matching sources, review inputs and one total, approve that request, and inspect saved results. It uses the existing Gateway for discovery, planning, prices, execution and evidence.

MCP1 card URLs, connection identity, token formats and cached Ask tool signatures remain compatible. Compatibility operations stay private to cards; new model connections continue to see Ask first. Both old and new approval calls share the same durable approval record.

The default is question-scoped source discovery. There is no global “browse the catalog” flow. For example, “What does ASML do?” should first call `apiosk_ask` with that question and display its matching sources; a model's general knowledge is not an Apiosk result.

This repository is the canonical `obcraft/apiosk-mcp` implementation. Versioned source and manifests do not establish that this version has been deployed, published or installed in a host.

## Ask interactions and embedded components

The server exposes **36 public tools and six private component operations**, saved-request resources and an Ask prompt. The actual App Ask React components and design tokens are vendored in `src/ask-page/` and compiled into the self-contained embedded resource. The local tester loads that same resource. `src/ask-ui/` retains the original MCP transport and compatibility renderers; every operation still uses the durable saved-request and approval journal.

Source discovery uses the App’s filtering, deduplication and provider ordering. Offered endpoint descriptors enrich matching sources without adding unrelated catalog entries. Account display currency comes from Gateway’s read-only `/v2/display-context`; quoted atomic amounts remain unchanged. Rebuild the embedded bundle with `npm run build:ask-page` after editing its sources.

MCP Apps and ChatGPT-compatible metadata identify the embedded resources. Model-visible results carry compact source identifiers, status, input needs and the exact approval. Full component data travels separately in `_meta.apiosk_card_data`, so large source schemas and raw response trees do not flood the model context. Saved evidence remains available through the result and evidence tools.

Hosts that support embedded components can show the interactive cards. Text-only hosts receive structured results and use the public tools. Support and rendering still depend on the host; passing local tests does not establish installed Claude, Codex or ChatGPT acceptance. Read-only HTML exports are separate from interactive cards.

| Interaction | Tools |
| --- | --- |
| Ask and inspect matching sources | `apiosk_ask`, `apiosk_sources` |
| Edit source inputs and prepare one total | `apiosk_prepare` |
| Review and explicitly approve the exact quote | `apiosk_approve` |
| Read progress, refresh prices, supply choices or missing input | `apiosk_status`, `apiosk_requote`, `apiosk_continue` |
| Retry interrupted discovery and adjust task options | `apiosk_retry_search`, `apiosk_task_options`, `apiosk_source_selection`, `apiosk_analysis_quote` |
| Saved answers, evidence, pages, downloads and conversations | `apiosk_result`, `apiosk_evidence`, `apiosk_result_page`, `apiosk_artifact`, `apiosk_chats` |
| Follow up using purchased evidence | `apiosk_follow_up` |
| Connected app actions and recurring checks | Integration/action review tools, native recurring tools and `apiosk_schedule_handoff` |

`apiosk_ask` defaults to `mode: "sources"`. Automatic planning is available with `mode: "automatic"`. Preparation never approves a purchase. Review the returned currency, maximum total, sources, gaps, expiry and approval ID before authorizing execution. The visible choices use the same purchasability filter as the Ask page; discovery metadata and source options are not purchased findings.

Results retain source dates, citations, coverage and gaps, including meaningful `0` and `false` values. Local filters, sorting, chart/table views, saved pages and exports reuse saved data. Follow-ups use purchased evidence where possible; a need for new data creates a separately reviewed request.

## Run from this checkout

Requires Node.js 22.16 or newer and an authorized Apiosk connection. In this workspace the canonical directory is `/Users/olivier/Documents/Apiosk/Production/Main/mcp`.

```sh
cd /Users/olivier/Documents/Apiosk/Production/Main/mcp
npm ci
npm run check
npm test
```

Use the existing Apiosk credentials in your private environment or local `.env`; do not put credentials in committed examples. Runtime entry points read environment variables. To load `.env` explicitly, use Node's `--env-file` option.

| Entry point | Purpose |
| --- | --- |
| `node index.mjs` / `npm run start:stdio` | Local stdio MCP; uses the configured connection token. The `apiosk`, `apiosk-mcp` and `apiosk-mcp-server` package commands use this entry. |
| `node server.mjs` / `npm start` | Canonical hosted HTTP server, default port **3000**, with OAuth metadata, registration, authorization and token routes. Also retains authenticated legacy SSE endpoints. |
| `node bin/mcp-2.mjs --http --host 127.0.0.1 --port 3012` | Minimal bearer-token HTTP transport for local testing. This compatibility filename remains internal; this entry does not provide the hosted OAuth flow. |

For stdio with a private `.env`:

```sh
node --env-file=.env index.mjs
```

The hosted server preserves the existing OAuth identity and secret configuration. Starting it requires those settings, including its signing secret; use `node --env-file=.env server.mjs` when they are in a local file. HTTP clients authenticate each request themselves. A server-wide token is never lent to HTTP callers. `/health` reports process health, not Gateway or source readiness.

## Local tester

The tester runs at **http://127.0.0.1:3013** and defaults to an MCP endpoint at **http://127.0.0.1:3012/mcp**. Start the minimal local MCP transport in one terminal:

```sh
node --env-file=.env bin/mcp-2.mjs --http --host 127.0.0.1 --port 3012
```

Start the tester in another:

```sh
npm run dev:chat
```

To test the canonical hosted server on port 3000 instead:

```sh
MCP_DEV_URL=http://127.0.0.1:3000/mcp npm run dev:chat
```

The tester reads this checkout's `.env`, `.env.v2.local` and `.env.dev.local`, with inherited environment values taking precedence. It reuses an existing `MCP_DEV_TOKEN` and `OPENROUTER_API_KEY`. If no local OpenRouter key is set, it reads only the provider key from the sibling `gateway/.env` (`OPENROUTER_API_KEY`, then `INTENT_API_KEY`). It does not inherit Gateway execution flags or change those credentials. `MCP_DEV_PORT`, `MCP_DEV_URL` and `MCP_DEV_MODEL` override the tester defaults. Set `MCP_DEV_GATEWAY_URL` for a custom Gateway event origin; the embedded card and tester use the same fixed origin policy for live status updates.

Connect the intended account before asking a question. The tester calls `apiosk_ask` for the first question and renders the same embedded components served to other hosts. An initial discovery stops at the authoritative Ask card without an extra model-written answer. Later model continuations receive a bounded projection of tool results; full card data stays available to the component. Model API usage and approved source purchases are separate operations.

## Connect Claude or Codex

Use [examples/codex.toml](examples/codex.toml), [examples/claude-code.mcp.json](examples/claude-code.mcp.json) or [examples/claude-desktop.json](examples/claude-desktop.json), preserving other configured servers. Adjust absolute paths for your installation and keep tokens in private configuration or environment variables. These files are examples, not an installed connection.

The hosted connector address remains `https://mcp.apiosk.com/mcp`; local source changes do not update that deployment. The [Apiosk plugin](plugin/apiosk/) supplies Ask-first instructions and the hosted connection definition. `server.json`, `manifest.json` and `dxt.json` describe the canonical package; a desktop manifest is not a built or installed bundle.

## Configuration and backend boundaries

| Variable | Meaning |
| --- | --- |
| `APIOSK_GATEWAY_V2_URL` | Data/execution Gateway; defaults to `https://gateway.apiosk.com`. Use loopback HTTP only for a local Gateway. |
| `APIOSK_GATEWAY_URL` | Existing OAuth agent gateway setting; it does **not** select the data/execution Gateway. |
| `APIOSK_CONNECT_TOKEN` | Apiosk agent connection credential for stdio. |
| `APIOSK_TOKEN` | Overrides the connection token. A valid personal App session JWT enables account-only routes; this server does not refresh that App session. |
| `APIOSK_WORKSPACE_ID` | Stdio workspace. HTTP callers use `x-apiosk-workspace-id`. |
| `APIOSK_MCP_STATE_DIR` | Persistent private journal directory; defaults to `.local/state` in the package. |
| `APIOSK_MCP_PORT` / `PORT` | HTTP port; defaults to 3000. |
| `APIOSK_MCP_HOST` / `APIOSK_MCP_BIND_HOST` | Listener address. The hosted entry defaults to `0.0.0.0`; use loopback for local-only access. |
| `APIOSK_MCP_ALLOWED_HOSTS`, `APIOSK_MCP_ALLOWED_ORIGINS` | Explicit host/origin controls for the HTTP listener. |

Gateway scope, budget, workspace and feature restrictions remain authoritative. Organization API keys are not substitutes for agent connection tokens in the raw task/approval protocol. Account-only integrations and native recurring operations may require a valid App session and backend enablement; an `app_only` or `public_api_required` response is not bypassed.

Connection tokens use the Gateway's public `/v2/ask` discovery path. App sessions use its App discovery path. Those backend paths can classify the same question differently; this MCP preserves the returned matches and does not guarantee identical source rankings. A live ASML discovery check exposed unrelated direct matches in the connection-token response. This remains an upstream relevance issue; returned source coverage must be reviewed before approval.

Recurring execution needs its own explicit review of the workflow, schedule, destination and cost limits. `apiosk_schedule_handoff` supplies instructions for the host scheduler and reports `schedule_created: false`; it does not create a scheduled job. External app actions likewise require their own reviewed execution.

## Saved state, recovery and deployment

The journal stores private conversations, evidence and approval intent with private file permissions, without storing credentials. Conversations are separate from the web app's chat-history table; authorized Gateway tasks can be imported by ID. State scopes include the Gateway and workspace. Raw bearer callers are token-scoped; hosted OAuth sessions retain their verified grant scope across token refresh.

Atomic writes and per-request locks record approval intent before dispatch. An uncertain purchase is not blindly replayed: read saved status and use the returned recovery path. The quoted total is a spending ceiling across providers, not an all-or-nothing transaction. Local disk failures stop money-moving actions.

Hosted operation requires a persistent journal. The Fly configuration preserves the existing app identity and expects an existing `mcp_state` volume mounted at `/data`; run **one machine** until shared state and distributed locking are implemented. Provision and review that volume before deploying. See [deployment and release instructions](docs/deployment.md).

Pushing the repository runs checks only. Deployment and publication are separate manual workflows. Tests use controlled fixtures and do not purchase source data; local success is not proof of production retrieval, message delivery, a running schedule or an installed host connection.
