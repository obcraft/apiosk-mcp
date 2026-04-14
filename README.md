# Apiosk MCP Server

Official MCP server for discovering, paying for, and publishing Apiosk APIs.

## Quick Start

### Local stdio package

```bash
npx -y apiosk-mcp-server
```

### With automatic x402 payments from an env wallet

```bash
APIOSK_PRIVATE_KEY=0x... npx -y apiosk-mcp-server
```

### With dashboard-managed access

```bash
APIOSK_CONNECT_TOKEN=... npx -y apiosk-mcp-server
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
      "args": ["-y", "apiosk-mcp-server"]
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
      "args": ["-y", "apiosk-mcp-server"]
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
      "args": ["-y", "apiosk-mcp-server"]
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
      "args": ["-y", "apiosk-mcp-server"]
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
      "args": ["-y", "apiosk-mcp-server"]
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

Protected tools on the hosted server use OAuth. Public discovery stays open, but paid execution, credits, and managed-wallet tools will trigger an Apiosk sign-in flow the first time the app calls them.

## Available Tools

Static tools:

- `apiosk_help`
- `apiosk_explore`
- `apiosk_search`
- `apiosk_get_api`
- `apiosk_execute`

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

- one dynamic tool per active Apiosk API slug, generated from listing metadata

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

### Dynamic tool call

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
- runs live `apiosk_search`, `apiosk_explore`, and `apiosk_get_api`
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
- `APIOSK_DASHBOARD_URL`: override the human-facing dashboard/app URL stored in local config and used in confirmation flows. Defaults to `https://apiosk.com`
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
