<!-- mcp-name: io.github.obcraft/apiosk-mcp -->
<p align="center">
  <img src="https://apiosk.com/logo.svg" alt="Apiosk" width="120" />
</p>

# Apiosk MCP Server

[![smithery badge](https://smithery.ai/badge/olivier-fovn/apiosk)](https://smithery.ai/servers/olivier-fovn/apiosk)

**Verifiable data for your chatbot.** Ask a data question, review one plan and
one total price ceiling, approve it within your connected account's spending
limits, and receive source-backed results. Resume without buying the same work
twice.

[![MCP Registry](https://img.shields.io/badge/MCP_Registry-io.github.obcraft%2Fapiosk--mcp-2ea44f)](https://registry.modelcontextprotocol.io)
[![npm](https://img.shields.io/npm/v/@apiosk/mcp?label=npm%20%40apiosk%2Fmcp)](https://www.npmjs.com/package/@apiosk/mcp)
[![PyPI](https://img.shields.io/pypi/v/apiosk-mcp?label=PyPI%20apiosk-mcp)](https://pypi.org/project/apiosk-mcp/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](#license)

- **Hosted endpoint:** `https://mcp.apiosk.com/mcp` (streamable HTTP; the host signs in with OAuth when it connects).
- **Local stdio package:** `npx -y @apiosk/mcp` or `uvx apiosk-mcp`.
- **Apiosk app:** [app.apiosk.com](https://app.apiosk.com) — connections, spending limits, balance and approvals.

## 2.0: one runtime, Gateway v2

Every tool speaks the Gateway v2 agent contract at `https://gateway.apiosk.com`,
for the hosted server and for stdio alike. The eleven 1.x tools (the one-shot
offer, compare, plan and job tools) called the agent gateway's `/v1/ask`,
`/v1/select`, `/v1/run`, `/v1/plans` and `/v1/jobs` routes, which now answer
`410 moved_to_gateway_v2`. Sign-in still goes through the agent gateway's OAuth
endpoints.

## The tools

| Tool | What it does | Gateway v2 route | Spends |
| --- | --- | --- | --- |
| `apiosk_sources` | Browse published data sources by name, category, sector, tag or capability. Paginated with `next_offset`. | `GET /v2/sources` | no |
| `apiosk_discover` | Plan a NEW data question: one plan with `proposal.max_total_atomic` as the total price ceiling, or the clarification it needs. A fixed company or tender dossier can be started with `workflow` instead of `question`. | `POST /v2/discover`, `POST /v2/workflows/{slug}/start` | no |
| `apiosk_search` | Search sources the way the Ask page does, with a `parsed_request` capability object the chatbot fills in itself (the Ask parser's schema). Returns ranked sources per capability; each runnable candidate carries `endpoint.inputs`, the exact input keys for `apiosk_prepare`. | `POST /v2/ask-v2/search` | no |
| `apiosk_prepare` | Prepare one searched endpoint with its filled-in `input`: the same task, price ceiling and approval card as `apiosk_discover`. | `POST /v2/ask-v2/prepare` | no |
| `apiosk_execute` | Continue the same task with a returned `next_actions` entry: supply input, select an entity, run an approved step, cancel. | `POST /v2/execute` | only an approved step |
| `apiosk_status` | Read a task's saved results, actual charges and status. Free and read-only; used for follow-ups and recovery. | `GET /v2/tasks/{id}` | no |
| `apiosk_approve` | **App-only.** Called by the interactive card when the person clicks Approve; approves that exact ceiling within the connection's spending limits and starts server execution. Never invoked by the model. | `POST /v2/approve` | yes, within the approved ceiling |

### Approval

The task's `context_view.approval_mode` decides where a person approves:

- `chatbot` — the interactive card shows the plan and total and an **Approve**
  button. One click approves the whole request within the connected account's
  spending limits; the server then runs every step and streams the result into
  the card (`context_view.events_url`).
- `app` — the person approves at `proposal.approval_url` in the Apiosk app. The
  server continues automatically after approval; read progress with
  `apiosk_status`.

A chat message, a tool permission or `approved: true` is never an approval.
Loading a card or recovering a task never approves or buys.

### Recovery

Every response carries `state.state_ref`. If state is lost or a response was
interrupted, call `apiosk_status` with `{"task_ref": "<state_ref>"}`. It reads
only; it never parses, approves or buys.

The complete host contract the tools follow is served as the MCP resource
`apiosk://v2/host-contract` and in the server instructions.

## Quick start

```bash
npx -y @apiosk/mcp
```

The PyPI package is a launcher for it, so `uvx apiosk-mcp` starts the same
server. Both expose the same CLI binaries: `apiosk-mcp`, `apiosk-mcp-server`
and `apiosk`.

For stdio, set `APIOSK_CONNECT_TOKEN` to an Apiosk agent token
(`apk_access_…` from a connection made in the Apiosk app, or a legacy
`apk_live_…` agent key). Every tool acts for that connected account; without a
token the tools answer `unauthorized`. The hosted server uses OAuth instead.

## Agent configuration

### Claude Code

```bash
claude mcp add --transport http apiosk https://mcp.apiosk.com/mcp
```

### Claude Team and Enterprise

An organization owner adds a custom Web connector in **Organization settings → Connectors** with the URL `https://mcp.apiosk.com/mcp`. Choose OAuth sign-in and **Register automatically** for the OAuth client: Apiosk publishes a dynamic registration endpoint; its current metadata does not advertise client-ID metadata documents. Members then connect individually in **Customize → Connectors** and authorize their Apiosk account and spending limits.

Send a complete multi-part workflow to `apiosk_discover` for one plan and price ceiling. The user approves that plan in the card or Apiosk approval page, unless a previously configured connection rule already covers it. Reading a saved task with `apiosk_status` never buys it again. Missing source access or data coverage remains visible in the returned task.

See [Claude's custom connector setup](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp). A custom connector does not require an Apiosk listing in the connector directory.

### Claude Desktop, Cursor, Windsurf, Cline, Continue, Goose

```json
{
  "mcpServers": {
    "apiosk": {
      "command": "npx",
      "args": ["-y", "@apiosk/mcp"],
      "env": { "APIOSK_CONNECT_TOKEN": "apk_access_…" }
    }
  }
}
```

### VS Code

```json
{
  "servers": {
    "apiosk": {
      "type": "http",
      "url": "https://mcp.apiosk.com/mcp"
    }
  }
}
```

### ChatGPT and other remote MCP apps

Use `https://mcp.apiosk.com/mcp`. The host starts OAuth when it connects;
sign-in and spending limits live in the Apiosk app.

The OpenAI plugin package lives in `plugin/apiosk`. It combines this MCP server
with the `apiosk` skill (`plugin/apiosk/skills/apiosk`).

## Examples

```json
{ "name": "apiosk_sources", "arguments": { "capability": "eu.company.profile" } }
```

```json
{ "name": "apiosk_discover", "arguments": { "question": "Latest filed annual accounts for Mollie B.V. from KVK" } }
```

```json
{ "name": "apiosk_execute", "arguments": { "action_id": "<next_actions[].action_id>", "state": { "…": "the newest state, unchanged" }, "input": { "value": "…" } } }
```

```json
{ "name": "apiosk_status", "arguments": { "task_ref": "<state.state_ref>" } }
```

## Environment variables

- `APIOSK_CONNECT_TOKEN` — stdio only: the Apiosk agent token sent as `Authorization: Bearer …` to Gateway v2. Hosted MCP obtains the token through OAuth.
- `APIOSK_GATEWAY_V2_URL` — the Gateway v2 origin. Defaults to `https://gateway.apiosk.com`; set only for a local (`http://127.0.0.1:…`) or staging gateway.
- `APIOSK_GATEWAY_URL` — the agent gateway used for hosted OAuth. Leave unset unless testing against staging.
- `APIOSK_MCP_OAUTH_SECRET` — signing secret for hosted OAuth codes, access tokens and refresh tokens.
- `APIOSK_MCP_PUBLIC_BASE_URL` — this server's own public URL.

This server holds no keys, prices nothing and moves no money: Gateway v2 plans,
prices, enforces the spending limits and executes.

## Remote HTTP server

Hosted OAuth metadata and authorization routes live on the same host:

- `https://mcp.apiosk.com/.well-known/oauth-authorization-server`
- `https://mcp.apiosk.com/.well-known/oauth-protected-resource/mcp`
- `https://mcp.apiosk.com/authorize`
- `https://mcp.apiosk.com/token`
- `https://mcp.apiosk.com/register`
- `https://mcp.apiosk.com/.well-known/mcp/server-card.json`

```bash
curl https://mcp.apiosk.com/health
```

## Development

```bash
npm install
npm test        # node --test
npm run dev     # HTTP server on :3000
node index.mjs  # stdio
```

`test/surface.test.mjs` asserts the tool list by name and that the published
manifests (`dxt.json`, `server.json`, this file) and versions agree with it.
`src/gateway-v2-contracts.json` and `src/gateway-v2-instructions.md` are
generated from `gateway/contracts/` by `gateway/scripts/sync-contracts.mjs`; do
not edit them here.

## License

MIT
