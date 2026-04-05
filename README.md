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
claude mcp add --transport http apiosk https://apiosk-mcp.fly.dev/mcp
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

## Available Tools

Static tools:

- `apiosk_help`
- `apiosk_explore`
- `apiosk_search`
- `apiosk_get_api`
- `apiosk_execute`

Local wallet tools in stdio mode:

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

## Environment Variables

- `APIOSK_PRIVATE_KEY`: enables automatic x402 settlement and signed publish requests
- `APIOSK_CONNECT_TOKEN`: attach a dashboard-managed connect token
- `APIOSK_CONNECT_AUTHORIZATION`: attach a custom Authorization header
- `APIOSK_CONNECT_HEADER_NAME`: override the connect-token header name
- `APIOSK_WALLET_ADDRESS`: send a wallet address for wallet-aware flows
- `APIOSK_X_PAYMENT`: attach a pre-built x402 proof manually
- `APIOSK_GATEWAY`: override the gateway base URL
- `APIOSK_DASHBOARD_JWT` or `APIOSK_USER_JWT`: unlock dashboard wallet routes
- `APIOSK_ENABLE_LOCAL_WALLETS=true`: enable local wallet tools in HTTP server mode
- `APIOSK_HOME`: override the default `~/.apiosk` directory
- `APIOSK_MCP_WALLET_STORE`: override the local wallet store path

## Remote HTTP Server

The public HTTP deployment is safe-by-default: local wallet and publish tools are disabled unless `APIOSK_ENABLE_LOCAL_WALLETS=true` is set on that server.

Test it:

```bash
curl https://apiosk-mcp.fly.dev/health
```

```bash
curl https://apiosk-mcp.fly.dev/mcp \
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
