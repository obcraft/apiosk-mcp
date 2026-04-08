# Apiosk MCP Marketplace Submission

## Name

Apiosk MCP

## Short description

Official MCP server for discovering, paying for, and executing Apiosk APIs with pay-per-request billing.

## One-line value proposition

Give agents direct access to paid APIs without API keys or subscriptions.

## Long description

Apiosk MCP turns the Apiosk gateway into an agent-native tool surface for Claude Code, Codex, Cursor, and other MCP clients.

It gives agents:

- catalog-backed API discovery
- dynamic tool generation from live listing metadata
- pay-per-request execution through Apiosk
- support for credits and x402 payment flows
- local wallet and publish flows in the local stdio package

This makes Apiosk useful both for agent users who want to call tools on demand, and for API builders who want to monetize endpoints in an agent-native way.

## Hosted endpoint

`https://mcp.apiosk.com/mcp`

## Install

### Claude Code

```bash
claude mcp add --transport http apiosk https://mcp.apiosk.com/mcp
```

### Codex

```bash
codex mcp add apiosk --url https://mcp.apiosk.com/mcp
```

### Local package

```bash
npx -y apiosk-mcp-server
```

## Core capabilities

- Discover APIs in the Apiosk catalog
- Search APIs by keyword and listing metadata
- Inspect API pricing, routes, and MCP metadata
- Execute paid APIs through a single MCP surface
- Use human-funded credits
- Use autonomous x402 wallet-based payments
- Publish APIs from the local MCP package

## Why it is different

- No API-key-first setup
- No subscription-first pricing model
- Payment is tied to the request itself
- New APIs can become available as tools without hand-maintained wrappers

## Ideal categories

- Developer tools
- AI agents
- MCP
- API marketplace
- Payments

## Tags

`mcp`, `agents`, `api`, `payments`, `developer-tools`, `x402`, `credits`, `marketplace`

## Support links

- Website: `https://apiosk.com`
- Docs: `https://docs.apiosk.com`
- MCP endpoint: `https://mcp.apiosk.com/mcp`
- Gateway: `https://gateway.apiosk.com`
- npm: `https://www.npmjs.com/package/apiosk-mcp-server`

## Notes for reviewers

The hosted MCP endpoint is intended for remote HTTP use. The npm package exposes additional local-first tools such as wallet creation, local config persistence, and API publishing.
