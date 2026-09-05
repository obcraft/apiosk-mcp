<!-- mcp-name: io.github.obcraft/apiosk-mcp -->
<p align="center">
  <img src="https://apiosk.com/logo.svg" alt="Apiosk" width="120" />
</p>

# Apiosk MCP Server

[![smithery badge](https://smithery.ai/badge/olivier-fovn/apiosk)](https://smithery.ai/servers/olivier-fovn/apiosk)

**Buy an API call the way a person would.** Describe the job, see what can do
it, compare the candidates on price and measured performance, choose one, and
pay for it in USDC over x402 — under limits the buyer set, enforced on every
call.

`payments` · `x402` · `commerce` · `usdc` · `api-comparison`

[![MCP Registry](https://img.shields.io/badge/MCP_Registry-io.github.obcraft%2Fapiosk--mcp-2ea44f)](https://registry.modelcontextprotocol.io)
[![npm](https://img.shields.io/npm/v/@apiosk/mcp?label=npm%20%40apiosk%2Fmcp)](https://www.npmjs.com/package/@apiosk/mcp)
[![PyPI](https://img.shields.io/pypi/v/apiosk-mcp?label=PyPI%20apiosk-mcp)](https://pypi.org/project/apiosk-mcp/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](#license)

- **Hosted endpoint:** `https://mcp.apiosk.com/mcp` (streamable HTTP; the first data request starts OAuth when needed).
- **Local stdio package:** `npx -y @apiosk/mcp` or `uvx apiosk-mcp`.
- **Buyer portal:** [buy.apiosk.com](https://buy.apiosk.com) — sign in, fund a wallet, set the limits, approve a held purchase.

## The eleven tools

Two paths, and the same rules on both. `apiosk` is the one-shot entrypoint for
fast shopping: it returns the App's own top ranked runnable provider and
approval card. An agent does not browse a menu: it reads descriptions and picks,
so every tool here earns its place in one of the two flows.

**One call**, when a single API answers the question:

| Tool | What it answers | Spends |
| --- | --- | --- |
| `apiosk` | Return the top ranked runnable provider, exact price, required inputs and Approve/Deny card. | no |
| `apiosk_connect` | Can this session buy? Which wallet, which policy, which limits. Returns the portal link when there is no connection. | no |
| `apiosk_discover` | What can perform this job? Sweeps the reviewed Apiosk catalogue **and** the wider x402 ecosystem. | no |
| `apiosk_compare` | How do the candidates perform against *my* requirements? Price, measured p95 latency, measured success rate and input fit, each offer carrying a stable `offer_id`. | no |
| `apiosk_execute` | Run the offer the user chose, at the price they were shown. | **yes** |
| `apiosk_approval_status` | What happened to the purchase the buyer's rules put on hold? | no |

**Several calls**, when a lookup's result feeds the next call, or several facts
are wanted about one subject:

| Tool | What it answers | Spends |
| --- | --- | --- |
| `apiosk_plan` | What would answering this take, in what order, and what is the one price for all of it? Returns the steps, what it cannot reach, and a signed `plan_token`. | no |
| `apiosk_execute_plan` | Start the plan the user approved, by `plan_token` and nothing else. | **yes** |
| `apiosk_job_status` | Where has the running plan got to, and what happened since the last cursor? | no |
| `apiosk_resolve_job` | Which subject was meant, when the job stopped to ask? | no |
| `apiosk_cancel_job` | Stop dispatching further calls. Calls already sent are still settled. | no |

The plan is compiled, deduplicated and priced by the gateway, never here: a
lookup two branches both need is bought once, and a fact you already hold
removes its lookup from the plan and from the price. The App and this server
show the same `plan_hash` and the same amount for the same intent because
exactly one of them computes it.

Anything a buyer needs that is not on this list is a link to
[app.apiosk.com](https://app.apiosk.com), not a tool. This server holds no keys,
prices nothing and moves no money.

### The one rule

`apiosk_compare` and `apiosk` return offers. **A person approves or denies the
purchase.** The quick card states the provider and exact price and supplies the
two actions; do not add a second prose confirmation. Only Approve may pass the
signed `offer_token`, exact `max_price_usdc` ceiling and entered inputs to
`apiosk_execute`. Deny stops without spending.

A plan is the same rule at plan scale: **one confirmation, for the whole plan,
at the whole price.** `apiosk_plan` asks it once and returns the answer in
`status`; `apiosk_execute_plan` asks nothing and accepts nothing but the
`plan_token`, so it cannot build a plan, change one, or re-open a decision that
was already made.

### How the user is asked

The choice and the approval are the same question in three renderings, built
from one description of the offers, so a row is called the same thing wherever
it appears:

| Host | What the person sees |
| --- | --- |
| Implements MCP elicitation (Claude Code) | A native picker: `apiosk_discover` lists the runnable offers with their prices, `apiosk` asks Approve or Deny with the price on the button, `apiosk_plan` asks Approve or Deny for the whole plan at its one ceiling. The answer comes back in `chosen` / `status`. |
| Renders UI resources (MCP Apps SEP-1865, OpenAI Apps SDK) | A card: `ui://apiosk/results-picker.html` picks an offer and collects its inputs, `ui://apiosk/connect-card.html` shows the balance and limits, `ui://apiosk/offer-card.html` approves one offer, `ui://apiosk/plan-card.html` approves one plan, `ui://apiosk/result-canvas.html` shows the result. One document serves both protocols. |
| Neither | `presentation`, printed verbatim, and the agent asks which one they want **by name**. Never ask somebody to reply with a number. For a plan the fallback is the App approval link in `approval.approve_url`. |

Interactive UI in Claude's own chat surfaces is limited to connectors approved
for the Connectors Directory, so the elicitation path is what a Claude user gets
today and the cards are what ChatGPT and MCP-UI hosts get.

### The three outcomes that are not failures

`apiosk_execute` can come back without a result, and none of these should be
retried blindly:

| `status` | Meaning | Next step |
| --- | --- | --- |
| `approval_required` | The buyer's rules need a human to say yes. Nothing was paid and nothing was called. | Tell the user, then poll `apiosk_approval_status`. Retry only once it reports approved. |
| `payment_required` | The balance cannot cover the call. | Call `apiosk_connect`, tell the user, stop. |
| `limit_exceeded` | This connection's per-call or daily ceiling refused the call. | Do not retry; only the buyer can change it. |
| `not_authorised` | The connection expired or was revoked. | Call `apiosk_connect` for the re-connect link, stop. |

`apiosk_execute_plan` adds one more, and it is not a failure either:

| `status` | Meaning | Next step |
| --- | --- | --- |
| `plan_stale` | The quote expired, the plan moved, or the fee schedule changed since the approval. Nothing was reserved. | Do not retry the token. Call `apiosk_plan` again and have the user approve the new plan and its price. |

## Quick start

```bash
npx -y @apiosk/mcp
```

The scoped npm package is canonical:

```bash
npm install @apiosk/mcp
```

It exposes the same CLI binaries:

```bash
npx -y @apiosk/mcp
apiosk-mcp
apiosk-mcp-server
apiosk
```

The PyPI package is a launcher for it, so `uvx apiosk-mcp` starts the same
server as `npx -y @apiosk/mcp`.

The hosted server starts its OAuth handoff on the first `/apiosk`, discovery or
comparison request, then resumes the request after the buyer approves the
connection at [buy.apiosk.com](https://buy.apiosk.com). For local stdio, set
`APIOSK_CONNECT_TOKEN` or call `apiosk_connect` for the connection link.

## Agent configuration

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "apiosk": {
      "command": "npx",
      "args": ["-y", "@apiosk/mcp"]
    }
  }
}
```

### VS Code

```bash
code --add-mcp '{"name":"apiosk","command":"npx","args":["-y","@apiosk/mcp"]}'
```

Or `.vscode/mcp.json` (VS Code uses a `servers` key):

```json
{
  "servers": {
    "apiosk": {
      "command": "npx",
      "args": ["-y", "@apiosk/mcp"]
    }
  }
}
```

The hosted endpoint instead of the local package:

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

### Claude Code

```bash
claude mcp add --transport http apiosk https://mcp.apiosk.com/mcp
```

### Cursor, Windsurf, Cline, Continue, Goose

```json
{
  "mcpServers": {
    "apiosk": {
      "command": "npx",
      "args": ["-y", "@apiosk/mcp"]
    }
  }
}
```

### A local checkout

```json
{
  "mcpServers": {
    "apiosk": {
      "command": "node",
      "args": ["/full/path/to/apiosk-mcp/index.mjs"]
    }
  }
}
```

### ChatGPT and other remote MCP apps

Use `https://mcp.apiosk.com/mcp`. The first tool that reads provider data starts
OAuth automatically when the session is not connected; sign-in and spending
limits live on the buyer portal. `apiosk_connect` remains available as the
read-only diagnostic and reconnection entrypoint.

The OpenAI plugin package lives in `plugin/apiosk`. It combines this MCP server
with the `apiosk` skill, so one installation provides both the live tools and
the workflow instructions. The hosted server also exposes the bounded MCP
skills extension used by OpenAI's **Scan Tools** action. A skill-only upload is
available from the same source at `plugin/apiosk/skills/apiosk`.

## Examples

### Check the connection

```json
{ "name": "apiosk_connect", "arguments": {} }
```

Unconnected, it returns the portal link and says plainly that nothing can be
paid for yet. Connected, it names the wallet, the policy and the exact
per-transaction and daily limits, so the agent can quote them to the user
without a second round trip.

### Find and compare

```json
{ "name": "apiosk_discover", "arguments": { "query": "realtime USD to EUR exchange rate" } }
```

```json
{ "name": "apiosk_compare", "arguments": { "query": "realtime USD to EUR exchange rate", "max_price_usdc": 0.01 } }
```

Every score carries the weights that produced it and each candidate's
contribution per dimension, so it can be recomputed rather than trusted.
Dimensions Apiosk has not measured are named and dropped from the weighting —
never scored zero.

### Quick one-shot flow (`/apiosk`)

```json
{ "name": "apiosk", "arguments": { "query": "realtime USD to EUR exchange rate", "max_price_usdc": 0.01 } }
```

The result card shows the shared ranking's top provider, the exact per-call
price and any required fields. **Approve** runs `apiosk_execute`; **Deny** stops
without spending. In clients without MCP Apps UI, render those same two named
choices and wait for the user's decision.

### Buy the one the user chose

```json
{
  "name": "apiosk_execute",
  "arguments": {
    "offer_token": "tok_...",
    "max_price_usdc": 0.004,
    "input": { "from": "USD", "to": "EUR" },
    "input_parts": {
      "path": {},
      "query": { "from": "USD", "to": "EUR" },
      "body": {}
    },
    "prompt": "realtime USD to EUR exchange rate"
  }
}
```

The ceiling is not decoration: the call is refused rather than paid if the real
price is above the number the user was shown.

### Wait on an approval

```json
{ "name": "apiosk_approval_status", "arguments": { "approval_id": "2f8656ec-e667-4c8f-a340-a8dc2ddc36bc" } }
```

### Plan a job that needs more than one call

```json
{
  "name": "apiosk_plan",
  "arguments": {
    "question": "Is Mollie a healthy company?",
    "intent": {
      "subjects": [{ "role": "subject", "known": { "company.name": "Mollie B.V." } }],
      "required_outputs": ["company.profile", "company.financial_statements"],
      "jurisdiction": "NL"
    },
    "max_price_usdc": 0.25
  }
}
```

The result carries the steps in the order they run, whatever the plan could not
reach, one `total_usdc` ceiling and a signed `plan_token`. It spends nothing.
A `company.registration.nl.kvk` in `known` removes the identity lookup from both
the steps and the price.

### Start it, watch it, answer it

```json
{ "name": "apiosk_execute_plan", "arguments": { "plan_token": "pt_..." } }
{ "name": "apiosk_job_status",   "arguments": { "job_id": "…", "after": 0 } }
{ "name": "apiosk_resolve_job",  "arguments": { "job_id": "…", "node_key": "n_lookup", "chosen": "30528634" } }
{ "name": "apiosk_cancel_job",   "arguments": { "job_id": "…" } }
```

Starting the same approved plan twice gives one job, not two. The job outlives
the conversation, and the same job is visible and manageable in the Apiosk app —
only cancel one when the user asks to stop.

## Environment variables

- `APIOSK_CONNECT_TOKEN` — a connect token from [buy.apiosk.com](https://buy.apiosk.com), naming the account and spending policy for local stdio. Hosted MCP obtains it through OAuth.
- `APIOSK_GATEWAY_URL` — override the gateway base URL. Leave unset unless testing against staging.
- `APIOSK_BUYER_PORTAL_URL` — override the portal link `apiosk_connect` hands back.
- `APIOSK_MCP_OAUTH_SECRET` — signing secret for hosted OAuth codes, access tokens and refresh tokens.
- `APIOSK_MCP_PUBLIC_BASE_URL` — this server's own public URL, used in the served discovery document.

There is no `APIOSK_PRIVATE_KEY`. This server never holds a key; the gateway
settles from the buyer's managed wallet.

## Remote HTTP server

Hosted OAuth metadata and authorization routes live on the same host:

- `https://mcp.apiosk.com/.well-known/oauth-authorization-server`
- `https://mcp.apiosk.com/.well-known/oauth-protected-resource/mcp`
- `https://mcp.apiosk.com/authorize`
- `https://mcp.apiosk.com/token`
- `https://mcp.apiosk.com/register`

A machine-readable index of every paid x402 route published through Apiosk,
reshaped from the gateway's own document:

- `https://mcp.apiosk.com/.well-known/apiosk-routes.json` (alias `/discovery`)

Test it:

```bash
curl https://mcp.apiosk.com/health
```

```bash
curl https://mcp.apiosk.com/mcp -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Publishing an API

Publishing is not part of this server. The gateway's `/v1/apis/*` endpoints and
the provider portal serve it. This repository is the buyer's side of the
conversation, and nothing else.

## Development

```bash
npm install
npm test        # node --test
npm run dev     # HTTP server on :3000
node index.mjs  # stdio
```

`test/surface.test.mjs` asserts the tool list is exactly the six, by name, and
that the published manifests agree with it. If it fails, either a tool was added
without a decision or a manifest drifted — a tool name that disagrees across
`package.json`, `server.json`, `dxt.json` and this file is a broken install.

## License

MIT
