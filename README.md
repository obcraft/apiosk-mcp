# Apiosk MCP Server

MCP server for exploring and executing APIs via the Apiosk gateway.

## Quick Start

### npx (works immediately)

```bash
npx -y apiosk-mcp-server
```

## Agent Configuration

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "apiosk": {
      "command": "npx",
      "args": ["-y", "apiosk-mcp"]
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
      "args": ["-y", "apiosk-mcp"]
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
      "args": ["-y", "apiosk-mcp"]
    }
  }
}
```

### Claude Code

Add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "apiosk": {
      "command": "npx",
      "args": ["-y", "apiosk-mcp"]
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
      "args": ["-y", "apiosk-mcp"]
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

### `apiosk`

| Action | Description | Required params |
|--------|-------------|-----------------|
| `list` | Get all available APIs | - |
| `inspect` | Get details for a specific API | `api` |
| `execute` | Execute an API with payload | `api`, optionally `payload` |

**Examples:**

```json
{ "action": "list" }
{ "action": "inspect", "api": "weather" }
{ "action": "execute", "api": "weather", "payload": { "city": "Amsterdam" } }
```

## Remote HTTP Server

The server is also deployed at `https://apiosk-mcp.fly.dev/mcp` for direct HTTP access.

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
