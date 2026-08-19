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

- **Hosted endpoint:** `https://mcp.apiosk.com/mcp` (streamable HTTP, OAuth for the tools that spend).
- **Local stdio package:** `npx -y @apiosk/mcp` or `uvx apiosk-mcp`.
- **Buyer portal:** [buy.apiosk.com](https://buy.apiosk.com) — sign in, fund a wallet, set the limits, approve a held purchase.

## The five tools

There are five, and there is no sixth. An agent does not browse a menu: it reads
descriptions and picks, so every tool here earns its place in one flow.

| Tool | What it answers | Spends |
| --- | --- | --- |
| `apiosk_connect` | Can this session buy? Which wallet, which policy, which limits. Returns the portal link when there is no connection. | no |
| `apiosk_discover` | What can perform this job? Sweeps the reviewed Apiosk catalogue **and** the wider x402 ecosystem. | no |
| `apiosk_compare` | How do the candidates perform against *my* requirements? Price, measured p95 latency, measured success rate and input fit, each offer carrying a stable `offer_id`. | no |
| `apiosk_execute` | Run the offer the user chose, at the price they were shown. | **yes** |
| `apiosk_approval_status` | What happened to the purchase the buyer's rules put on hold? | no |

Anything a buyer needs that is not on this list is a link to
[buy.apiosk.com](https://buy.apiosk.com), not a tool. This server holds no keys,
prices nothing and moves no money.

### The one rule

`apiosk_compare` returns offers. **A person picks one.** State the exact price,
show the alternatives, wait for a choice, then pass that `offer_id` and a
`max_price_usdc` ceiling to `apiosk_execute`. There is deliberately no tool that
chooses for the user.

### The three outcomes that are not failures

`apiosk_execute` can come back without a result, and none of these should be
retried blindly:

| `status` | Meaning | Next step |
| --- | --- | --- |
| `approval_required` | The buyer's rules need a human to say yes. Nothing was paid and nothing was called. | Tell the user, then poll `apiosk_approval_status`. Retry only once it reports approved. |
| `payment_required` | The wallet is empty or over its limit. | Call `apiosk_connect` to see which, tell the user, stop. |
| `not_authorised` | The connection expired or was revoked. | Call `apiosk_connect` for the re-connect link, stop. |

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

Discovery and comparison work immediately, with no account and no credential.
To buy anything, connect once at [buy.apiosk.com](https://buy.apiosk.com) —
`apiosk_connect` returns the link.

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

Use `https://mcp.apiosk.com/mcp`. `apiosk_connect`, `apiosk_discover` and
`apiosk_compare` are served before authorization, so a user gets a real answer
before being asked for anything. `apiosk_execute` and `apiosk_approval_status`
are behind OAuth, and the sign-in lands on the buyer portal.

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

### Buy the one the user chose

```json
{
  "name": "apiosk_execute",
  "arguments": {
    "offer_id": "ofr_01J...",
    "max_price_usdc": 0.004,
    "query": { "from": "USD", "to": "EUR" }
  }
}
```

The ceiling is not decoration: the call is refused rather than paid if the real
price is above the number the user was shown.

### Wait on an approval

```json
{ "name": "apiosk_approval_status", "arguments": { "approval_id": "apr_01J..." } }
```

## Environment variables

- `APIOSK_CONNECT_TOKEN` — a connect token from [buy.apiosk.com](https://buy.apiosk.com), naming the wallet and the spending policy this server may buy under. Without one, discovery and comparison still work.
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

`test/surface.test.mjs` asserts the tool list is exactly the five, by name, and
that the published manifests agree with it. If it fails, either a tool was added
without a decision or a manifest drifted — a tool name that disagrees across
`package.json`, `server.json`, `dxt.json` and this file is a broken install.

## License

MIT
