# Apiosk MCP Server

Official MCP server for discovering and executing Apiosk APIs.

## Quick Start

### npx

```bash
npx -y apiosk-mcp-server
```

### With automatic x402 payments

```bash
APIOSK_PRIVATE_KEY=0x... npx -y apiosk-mcp-server
```

### With dashboard-managed access

```bash
APIOSK_CONNECT_TOKEN=... npx -y apiosk-mcp-server
```

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

Add to Cursor MCP settings:

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

Add to `~/.windsurf/mcp.json`:

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

Add with the Claude CLI:

```bash
claude mcp add --transport http apiosk https://apiosk-mcp.fly.dev/mcp
```

Or use the local stdio package:

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

### Using local path (before npm publish)

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

The server exposes:

- `apiosk_search`: browse and filter the public catalog
- `apiosk_get_api`: fetch listing detail plus agent metadata
- `apiosk_execute`: generic fallback execute tool
- one dynamic tool per active Apiosk API slug, using the listing's MCP metadata

### Discovery examples

```json
{ "search": "diff", "limit": 5 }
{ "slug": "agent-json-diff" }
```

### Generic execute example

```json
{
  "slug": "agent-json-diff",
  "input": {
    "before": { "ok": true },
    "after": { "ok": false }
  }
}
```

### Dynamic tool example

If the server lists a dynamic tool named `agent-json-diff`, call it directly with
the raw tool arguments:

```json
{
  "before": { "ok": true },
  "after": { "ok": false }
}
```

## Environment Variables

- `APIOSK_PRIVATE_KEY`: enables automatic x402 retry/payment for paid endpoints
- `APIOSK_CONNECT_TOKEN`: attach a dashboard-managed connect token
- `APIOSK_CONNECT_AUTHORIZATION`: attach a custom Authorization header
- `APIOSK_CONNECT_HEADER_NAME`: override the connect-token header name
- `APIOSK_WALLET_ADDRESS`: send a wallet address for wallet-aware flows
- `APIOSK_X_PAYMENT`: attach a pre-built x402 proof manually
- `APIOSK_GATEWAY`: override the gateway base URL

## Remote HTTP Server

Test it:

```bash
# Health check
curl https://apiosk-mcp.fly.dev/health

# List tools
curl https://apiosk-mcp.fly.dev/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Development

```bash
npm install
npm run dev    # HTTP server on :3000
node index.mjs # stdio mode
```

## License

MIT
