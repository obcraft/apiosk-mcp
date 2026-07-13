<p align="center">
  <img src="https://apiosk.com/logo.svg" alt="Apiosk" width="120" />
</p>

# Apiosk MCP Server

**AI-native payments for tools and APIs.** Discover, pay for, execute, and publish monetized APIs directly from your agent, over USDC/x402 or prepaid credits, through the Model Context Protocol.

`payments` · `finance` · `x402` · `commerce` · `crypto`

[![MCP Registry](https://img.shields.io/badge/MCP_Registry-io.github.obcraft%2Fapiosk--mcp-2ea44f)](https://registry.modelcontextprotocol.io)
[![npm](https://img.shields.io/npm/v/@apiosk/mcp?label=npm%20%40apiosk%2Fmcp)](https://www.npmjs.com/package/@apiosk/mcp)
[![PyPI](https://img.shields.io/pypi/v/apiosk-mcp?label=PyPI%20apiosk-mcp)](https://pypi.org/project/apiosk-mcp/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](#license)

Official MCP server for discovering, paying for, and publishing Apiosk APIs.

- **Listed in the [official MCP Registry](https://registry.modelcontextprotocol.io)** as `io.github.obcraft/apiosk-mcp`.
- **Hosted endpoint:** `https://mcp.apiosk.com/mcp` (streamable HTTP, OAuth-protected for paid tools).
- **Local stdio package:** `npx -y @apiosk/mcp` or `uvx apiosk-mcp` for wallet + publish tools.

## Quick Start

### Package names

The scoped npm package is the canonical client SDK package:

```bash
npm install @apiosk/mcp
```

It exposes the same CLI binaries as the legacy package:

```bash
npx -y @apiosk/mcp
apiosk-mcp
apiosk-mcp-server
apiosk
```

The previous public package name, `apiosk-mcp-server`, remains supported as a
compatibility install path for existing MCP client configs.

For MCP registry submission forms, use:

- npm Package: `@apiosk/mcp`
- PyPI Package: `apiosk-mcp`
- Short Description: `Discover, pay for, execute, and publish Apiosk APIs through MCP.`

The PyPI package is a launcher for the canonical npm package, so `uvx
apiosk-mcp` starts the same MCP server as `npx -y @apiosk/mcp`.

### Local stdio package

```bash
npx -y @apiosk/mcp
```

Python/uv users can install through PyPI:

```bash
uvx apiosk-mcp
```

The PyPI launcher requires Node.js 20+ and `npx` on `PATH`. By default it runs
`npx -y @apiosk/mcp@1.3.2`; set `APIOSK_MCP_NPM_PACKAGE=@apiosk/mcp@next` to
override the npm package spec.

### Publishing packages

From this `mcp/` directory:

```bash
npm run pack:check
npm publish --access public
```

```bash
python3 -m pip install --upgrade build twine
python3 -m build
python3 -m twine upload dist/apiosk_mcp-1.3.2*
```

After both uploads are live, the MCP registry package fields are:

```text
npm Package: @apiosk/mcp
PyPI Package: apiosk-mcp
Short Description: Discover, pay for, execute, and publish Apiosk APIs through MCP.
```

### With automatic x402 payments from an env wallet

```bash
APIOSK_PRIVATE_KEY=0x... npx -y @apiosk/mcp
```

### With dashboard-managed access

```bash
APIOSK_CONNECT_TOKEN=... npx -y @apiosk/mcp
```

After the MCP server is installed in Claude, Codex, or another client, the fastest first-run path in local stdio mode is:

```json
{ "wallet_label": "My Apiosk wallet" }
```

Call that through `apiosk_get_started`. It will create a local wallet when needed, or you can pass `connect_string` to save managed access locally and immediately run a discovery probe plus a small test call.

## Local Wallet Mode

The local stdio package exposes wallet tools that let Claude or Codex:

- create or import a wallet
- show the wallet address
- select the active wallet used for paid calls
- reveal or save the private key when the user explicitly asks
- publish and manage APIs without opening the dashboard

The active wallet is mirrored to:

- `~/.apiosk/wallet.json`
- `~/.apiosk/wallet.txt`

so older Apiosk scripts can reuse it.

## Agent Configuration

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

Add the server with the CLI:

```bash
code --add-mcp '{"name":"apiosk","command":"npx","args":["-y","@apiosk/mcp"]}'
```

Or create `.vscode/mcp.json` in your workspace (VS Code uses a `servers` key):

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

To use the hosted endpoint instead of the local package:

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

### Cursor

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

### Windsurf

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

### Claude Code

Remote HTTP:

```bash
claude mcp add --transport http apiosk https://mcp.apiosk.com/mcp
```

Local stdio:

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

### Cline / Continue / Goose

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

### Using a local checkout

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

Use the hosted MCP endpoint:

```text
https://mcp.apiosk.com/mcp
```

Protected tools on the hosted server use OAuth. The remote MCP surface is fully
capable, discovery, payment guidance, generic **and** dynamic per-API
execution, prepaid credits, and managed agent-wallet CRUD. Public tools
(discovery + guidance) work before authorization; paid execution and managed
tools require OAuth. Publishing stays local/portal-only because it needs a
client-side signing key the hosted server never holds.

## Provider MCP Monetization

If you own an MCP server and want to sell its tools through Apiosk, keep payment
logic out of your MCP. Apiosk is the paid edge.

Provider requirements:

- Host your MCP over HTTPS, for example `https://tools.example.com/mcp`.
- Support normal MCP `initialize`, `tools/list`, and `tools/call`.
- Keep tool names stable; imported tools become paid operation ids.
- Provide useful descriptions and JSON schemas; these become buyer-facing
  discovery metadata.
- Protect the provider MCP with bearer auth or another upstream secret, then
  configure Apiosk to inject that secret so buyers cannot bypass the gateway.

Provider portal flow:

1. Open the provider portal and choose `Import MCP`.
2. Enter the MCP URL and optional bearer token.
3. Apiosk scans `tools/list` and creates one paid action per selected tool.
4. Review tool paths, schemas, descriptions, and per-call prices.
5. Publish the draft after linking a payout wallet.

Buyer-facing surfaces after publish:

- Hosted Apiosk MCP: `https://mcp.apiosk.com/mcp`
- Catalog search: `https://gateway.apiosk.com/v1/apis?search=<slug>`
- Metadata: `GET https://gateway.apiosk.com/<slug>/metadata`
- Execution: `POST https://gateway.apiosk.com/<slug>/execute`

The traffic path is:

```text
buyer agent -> Apiosk MCP/gateway -> payment rail -> provider MCP tools/call
```

The provider MCP should reject direct unauthenticated traffic, but it should not
return `402 Payment Required` or inspect `X-Payment`. Payment challenges,
credits, x402 proof verification, and revenue splits are handled by Apiosk.

## Publish Paid x402 Routes from a Coding Agent

The hosted MCP doubles as a **publisher** for coding agents (Claude Code,
Cursor, Codex, and friends): build an API, then publish it as a paid x402
endpoint on the Apiosk gateway in one tool call.

Authenticate with an Apiosk **provider API key** (`sk_live_…`, minted in the
provider portal under Settings → API keys):

```json
{
  "mcpServers": {
    "apiosk": {
      "url": "https://mcp.apiosk.com/mcp",
      "headers": {
        "Authorization": "Bearer sk_live_YOUR_PROVIDER_KEY"
      }
    }
  }
}
```

Tools:

- `publish_x402_route`: create a paid route: name, `upstream_url`, `price`
  (USDC per call), `settlement_address`, optional `method`/`path`/schemas/tags.
  Returns the `paid_url` on `gateway.apiosk.com` plus the route's status.
- `list_x402_routes`: all your routes with paid URLs, prices, and status.
- `update_x402_route`: change price, description, upstream URL, schemas,
  settlement address, or status.
- `unpublish_x402_route`: disable a route (reversible).
- `test_x402_route`: fire an unpaid request at the paid URL and verify it
  returns `402 Payment Required` with a valid x402 `accepts[]` offer.
- `generate_openapi_spec`: host an OpenAPI 3.1 spec for the route at
  `https://mcp.apiosk.com/openapi/<route_id>.json`.
- `publish_project`: publish several routes of one project in a single call.

Lifecycle: new routes land in Apiosk's operator review queue
(`status: "pending_review"`). On approval they serve x402 payments, appear in
`https://gateway.apiosk.com/.well-known/x402`, and are auto-indexed in the
Coinbase x402 Bazaar. Settlement pays 98% of each call to your
`settlement_address` (Apiosk keeps a 2% platform fee).

Discovery endpoints for machines:

- `https://mcp.apiosk.com/.well-known/apiosk-routes.json` (alias `/discovery`)
 , machine-readable index of every paid route on the gateway.
- `https://mcp.apiosk.com/openapi/<route_id>.json`: per-route OpenAPI spec.

Local stdio use: set `APIOSK_PROVIDER_TOKEN=sk_live_…` instead of the header.
Hosted server operators must configure `APIOSK_SUPABASE_SERVICE_ROLE_KEY` (the
tools verify provider keys and write listings through the gateway database).

## Available Tools

Static tools:

- `apiosk_help`
- `apiosk_payment_guide`: buyer + provider guide for paying through and publishing on the gateway
- `apiosk_explore`
- `apiosk_search`
- `apiosk_discover`
- `apiosk_inspect_x402`
- `apiosk_fetch_paid`
- `apiosk_get_api`
- `apiosk_execute`

`apiosk_search` also returns matching x402 discovery sources in `sources`, even
when the Apiosk API catalog has no listing with that name. Each source includes
its direct REST/MCP endpoints and marks paid endpoints with
`payment_required`, `price_usdc`, and `executable_via`. `apiosk_discover` can
query the wired free sources directly; paid discovery sources such as x402scan
and Apify are returned as `apiosk_inspect_x402` → `apiosk_fetch_paid` pointers
and are never paid automatically.

Hosted remote MCP tools (in addition to dynamic per-API tools):

- Discovery / guidance: `apiosk_help`, `apiosk_payment_guide`, `apiosk_search`, `apiosk_explore`, `apiosk_discover`, `apiosk_inspect_x402`, `apiosk_get_api`, `apiosk_metadata`, `apiosk_execute`, `apiosk_health`
- External paid fetch: `apiosk_fetch_paid` (OAuth/connect-token protected; requires explicit live-price confirmation)
- Prepaid credits: `apiosk_buy_credits`, `apiosk_get_credits_status`
- Managed wallets: `apiosk_list_wallets`, `apiosk_create_wallet`, `apiosk_update_wallet`, `apiosk_delete_wallet`, `apiosk_get_wallet_activity`, `apiosk_create_wallet_connect_string`, `apiosk_list_wallet_api_keys`, `apiosk_create_wallet_api_key`, `apiosk_update_wallet_api_key`, `apiosk_delete_wallet_api_key`

Local wallet tools in stdio mode:

- `apiosk_get_started`
- `apiosk_wallet_list`
- `apiosk_wallet_create`
- `apiosk_configure`
- `apiosk_wallet_select`
- `apiosk_wallet_update`
- `apiosk_wallet_delete`
- `apiosk_wallet_reveal_secret`
- `apiosk_wallet_save_secret`

Publish tools in stdio mode:

- `apiosk_publish_api`
- `apiosk_list_my_apis`
- `apiosk_update_api`
- `apiosk_delete_api`

x402 publisher tools (all modes, provider-token auth):

- `publish_x402_route`
- `list_x402_routes`
- `update_x402_route`
- `unpublish_x402_route`
- `test_x402_route`
- `generate_openapi_spec`
- `publish_project`

Optional dashboard-managed wallet tools:

- `apiosk_list_wallets`
- `apiosk_create_wallet`
- `apiosk_update_wallet`
- `apiosk_delete_wallet`
- `apiosk_get_wallet_activity`
- `apiosk_create_wallet_connect_string`
- `apiosk_list_wallet_api_keys`
- `apiosk_create_wallet_api_key`
- `apiosk_update_wallet_api_key`
- `apiosk_delete_wallet_api_key`

Dynamic tools:

- local stdio mode still generates one dynamic tool per active Apiosk API slug from listing metadata

## Examples

### Explore

```json
{}
```

```json
{ "listing_type": "dataset", "search": "weather", "limit": 5 }
```

### Search

```json
{ "search": "diff", "limit": 5 }
```

Search, explore, and `apiosk_get_api` responses now embed a `payment` block that
tells the agent exactly how to settle a paid call given the current auth, so an
agent that finds, say, a weather API immediately knows whether it can pay and
what to do next.

### Payment guide (buyer + provider)

```json
{}
```

```json
{ "role": "provider" }
```

```json
{ "role": "buyer", "slug": "weather-now" }
```

Returns a buyer guide (USDC/x402 or credits, tailored to the configured auth)
and a provider guide (how to publish an API and get paid). Pass `slug` to scope
buyer guidance to one listing, or `role` to pick a side.

### Create a local wallet

```json
{ "label": "Claude wallet" }
```

The create response includes:

- the wallet address
- Base funding instructions
- a QR image URL
- a terminal QR block when QR rendering is enabled
- a structured Apiosk control menu with wallet, funding, pay, publish, security, and local-data sections

### Get started in one step

Create a local wallet automatically, discover the catalog, and run a test call:

```json
{
  "wallet_label": "Starter wallet",
  "test_slug": "agent-json-diff",
  "test_input": {
    "before": { "ok": true },
    "after": { "ok": false }
  }
}
```

Or save a dashboard-managed connect string locally and verify it:

```json
{
  "connect_string": "export APIO_GATEWAY_URL=https://gateway.apiosk.com\nexport APIO_CHAIN_ID=8453\nexport APIO_AGENT_WALLET_ADDRESS=0x...\nexport APIO_CONNECT_TOKEN=aw_...\nexport APIO_CONNECT_AUTHORIZATION=Bearer aw_...\nexport APIO_CONNECT_HEADER_NAME=X-Apiosk-Connect-Token",
  "test_slug": "agent-json-diff",
  "test_input": {
    "before": { "ok": true },
    "after": { "ok": false }
  },
  "create_wallet": false
}
```

The connect string identifies the buyer's managed wallet and connect token. The
`APIO_WALLET_*` limits bound the USDC (x402) rail. The same connect token also
settles over prepaid credits when USDC is unavailable, the gateway picks the
rail per call. Call `apiosk_help` with `topic="rails"` for the full settlement
model.

### Open the configure menu

```json
{ "section": "funding" }
```

```json
{ "wallet_id": "...", "section": "funding", "funding_provider": "onramper" }
```

### Save a secret key backup

```json
{ "wallet_id": "..." }
```

### Publish an API

```json
{
  "name": "My Weather API",
  "slug": "my-weather-api",
  "endpoint_url": "https://example.com",
  "price_usd": 0.01,
  "description": "Real-time weather data",
  "listing_group": "datasets"
}
```

### Generic execute

```json
{
  "slug": "agent-json-diff",
  "input": {
    "before": { "ok": true },
    "after": { "ok": false }
  }
}
```

### Dynamic tool call (local stdio only)

If the server lists a dynamic tool named `agent-json-diff`, call it directly:

```json
{
  "before": { "ok": true },
  "after": { "ok": false }
}
```

## MacBook Air Test Script

Run the safe default suite from a repo checkout:

```bash
cd /Users/olivierbrinkman/Development/Apiosk/subs/mcp
npm run test:macbook-air
```

Default coverage:

- runs `npm test`
- runs the isolated fresh-environment smoke test
- starts a local HTTP MCP server in a temp `APIOSK_HOME`
- verifies `health`, `tools/list`, `apiosk_search`, `apiosk_explore`, and `apiosk_get_api`
- creates a wallet, checks funding QR/configure output, and verifies secret export plus `wallet.json` and `wallet.txt`
- verifies the hosted Fly deployment, OAuth metadata, protected-resource metadata, public discovery, and the unauthenticated OAuth challenge for protected tools

Useful options:

- `TARGET=local` to skip hosted checks
- `TARGET=hosted` to skip local checks
- `APIOSK_RUN_REMOTE_WALLET_TEST=1 APIOSK_MCP_BEARER_TOKEN=...` to verify an authenticated protected hosted call after the unauthenticated challenge check
- `APIOSK_RUN_FUNDED_TESTS=1 APIOSK_TEST_PRIVATE_KEY=0x...` to import a funded wallet and run a real paid execute test
- `APIOSK_RUN_FUNDED_TESTS=1 APIOSK_MCP_BEARER_TOKEN=... TARGET=hosted` to run a real paid execute test through the hosted OAuth path
- `APIOSK_RUN_FUNDED_TESTS=1 APIOSK_RUN_PUBLISH_TEST=1 APIOSK_TEST_PRIVATE_KEY=0x... TARGET=local` to also test publish, list, update, and delete with a temporary listing

Example funded run:

```bash
cd /Users/olivierbrinkman/Development/Apiosk/subs/mcp
APIOSK_RUN_FUNDED_TESTS=1 \
APIOSK_TEST_PRIVATE_KEY=0x... \
npm run test:macbook-air
```

## Live URL Test Script

Run a hosted-only test directly against the public MCP endpoint:

```bash
cd /Users/olivierbrinkman/Development/Apiosk/subs/mcp
npm run test:live
```

Default live coverage:

- checks `https://mcp.apiosk.com/health`
- verifies the hosted tool surface
- verifies `/.well-known/oauth-authorization-server`
- verifies `/.well-known/oauth-protected-resource/mcp`
- runs live `apiosk_explore`, `apiosk_metadata`, and `apiosk_health`
- verifies that an unauthenticated protected MCP tool call returns the expected OAuth `401` challenge

Optional live funded checks:

- `APIOSK_RUN_REMOTE_WALLET_TEST=1 APIOSK_MCP_BEARER_TOKEN=... npm run test:live`
- `APIOSK_RUN_FUNDED_TESTS=1 APIOSK_MCP_BEARER_TOKEN=... npm run test:live`

The live hosted suite no longer imports a private key into the hosted MCP. Protected live checks now rely on a real hosted OAuth bearer token, which matches the ChatGPT-style remote MCP flow.

## Environment Variables

- `APIOSK_PRIVATE_KEY`: enables automatic x402 settlement and signed publish requests
- `APIOSK_CONNECT_TOKEN`: attach a dashboard-managed connect token
- `APIOSK_CONNECT_AUTHORIZATION`: attach a custom Authorization header
- `APIOSK_CONNECT_HEADER_NAME`: override the connect-token header name
- `APIOSK_WALLET_ADDRESS`: send a wallet address for wallet-aware flows
- `APIOSK_X_PAYMENT`: attach a pre-built x402 proof manually
- `APIOSK_GATEWAY`: override the gateway base URL
- `APIOSK_CONTROL_PLANE_URL`: override the MCP-owned control-plane API base URL used for account, credits, and managed-wallet routes. Defaults to `https://mcp.apiosk.com`
- `APIOSK_DASHBOARD_URL`: override the human-facing dashboard/app URL stored in local config and used in confirmation flows. Defaults to `https://dashboard.apiosk.com`
- `APIOSK_DASHBOARD_JWT` or `APIOSK_USER_JWT`: unlock dashboard wallet routes
- `APIOSK_ENABLE_LOCAL_WALLETS=true`: enable local wallet tools in HTTP server mode
- `APIOSK_MCP_OAUTH_SECRET` or `APIOSK_MCP_AUTH_SECRET`: signing secret for hosted OAuth codes, access tokens, and refresh tokens
- `APIOSK_MCP_BEARER_TOKEN`: optional hosted OAuth access token used by the live scripts for authenticated protected-tool checks
- `APIOSK_HOME`: override the default `~/.apiosk` directory
- `APIOSK_MCP_WALLET_STORE`: override the local wallet store path

## Human-Funded Credits Flow

In the local stdio package, MCP can now help a human top up Apiosk credits and then let the agent spend those credits later:

1. `apiosk_create_account` if the user needs a new Apiosk account
2. `apiosk_sign_in` to store a local dashboard session token
3. `apiosk_buy_credits` to create an Adyen checkout link
4. `apiosk_get_credits_status` after payment to reconcile the top-up and confirm the balance

If signup does not return a session immediately, tell the user to confirm their email first and then call `apiosk_sign_in`.

These calls now target the MCP-owned control-plane surface by default:

- `https://mcp.apiosk.com/api/auth/mcp-sign-up`
- `https://mcp.apiosk.com/api/auth/mcp-sign-in`
- `https://mcp.apiosk.com/api/credits/topup`
- `https://mcp.apiosk.com/api/credits/reconcile`

## Remote HTTP Server

The public HTTP deployment is safe-by-default: local wallet and publish tools are disabled unless `APIOSK_ENABLE_LOCAL_WALLETS=true` is set on that server.

Hosted OAuth metadata and authorization routes now live on the same host:

- `https://mcp.apiosk.com/.well-known/oauth-authorization-server`
- `https://mcp.apiosk.com/.well-known/oauth-protected-resource/mcp`
- `https://mcp.apiosk.com/authorize`
- `https://mcp.apiosk.com/token`
- `https://mcp.apiosk.com/register`

Test it:

```bash
curl https://mcp.apiosk.com/health
```

```bash
curl https://mcp.apiosk.com/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Development

```bash
npm install
npm run dev    # HTTP server on :3000
node index.mjs # stdio mode with local wallet tools enabled
```

Fresh-environment smoke test:

```bash
cd /Users/olivierbrinkman/Development/Apiosk/subs/mcp
npm run smoke:new-env
```

## License

MIT
