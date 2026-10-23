# Apiosk on Databricks

Apiosk is an external Streamable HTTP MCP server. Databricks connects to
`https://mcp.apiosk.com/mcp`; no data product migration or Databricks-hosted
copy of Apiosk is required. Marketplace publication is separate from connecting
an existing server in your workspace.

## Connect

In **Unity Gateway → MCPs → + MCP → Connect an existing MCP server**, select
a catalog/schema, name the service `apiosk`, and create an HTTP connection.
Use these values (the UI may offer a complete URL instead of separate fields):

| Field | Value |
| --- | --- |
| MCP URL | `https://mcp.apiosk.com/mcp` |
| Host | `https://mcp.apiosk.com` |
| Port | `443` |
| Base path | `/mcp` |
| Authentication | Dynamic Client Registration |
| OAuth scope | `mcp:tools offline_access` |

Click **Create & load tools**, sign in to Apiosk, and configure your Apiosk
connection limits. Each Databricks user connects their own account. Apiosk
advertises `/register`, `/authorize`, and `/token` through OAuth discovery.
Its PKCE method is S256. For manually registered confidential OAuth clients,
use `body_only` credential exchange (`client_secret_post`); Apiosk does not
advertise `client_secret_basic` or the `client_credentials` grant.

The Databricks callback is
`https://<workspace-hostname>/login/oauth/http.html`. Dynamic registration
records the callback supplied by the workspace; do not invent a shared client
ID or register another customer's callback.

The workspace needs Unity Catalog, a supported Model Serving region, access
to the catalog/schema and privileges to create the service and connection.
Restricted serverless networking must allow `mcp.apiosk.com`. Browser login
also needs access to Apiosk's sign-in services.

See [server registration](https://docs.databricks.com/aws/en/ai-gateway/register-mcp-service),
[HTTP connection authentication](https://docs.databricks.com/aws/en/query-federation/http),
and [network requirements](https://docs.databricks.com/aws/en/agents/mcp-tools/authentication-networking).

## Tools and purchase approval

Expose these tools in the service:

- `apiosk_sources`: browse sources without buying data.
- `apiosk_discover`: prepare a new data request.
- `apiosk_ask`: search, refresh the signed search, prepare chosen sources or a complete plan, and route saved-data follow-ups.
- `apiosk_external`: inspect or prepare an external Bazaar source, or read its saved purchase.
- `apiosk_execute`: continue a returned action on the same task.
- `apiosk_status`: read the existing task and saved results.

**Deselect `apiosk_approve`, `apiosk_requote` and `apiosk_external_approve`.** These belong to the interactive card, not the model. Do not rely on a host understanding the MCP Apps visibility metadata.

Databricks clients can consume `structuredContent` and JSON text responses
without rendering Apiosk's HTML card. The existing host contract explicitly
permits `proposal.approval_url` when the host cannot use the card. Show that
returned URL and the total ceiling to the person. A chat message or tool-use
permission is not purchase approval. After approval, the backend continues;
use `apiosk_status` and the existing task reference to recover saved results.
External Bazaar approval requires an interactive card; do not invoke the private approval tool from a headless agent.
An account's existing automatic-approval rules may authorize a request during
discovery; do not use discovery as a no-spend connectivity test.

## Bearer credentials for shared connections

Instead of DCR, a Unity Catalog connection can store an existing Apiosk bearer
credential. All users of that connection act under that credential's account
and limits. Do not put the secret in source code, a notebook or this guide.

The hosted authentication adapter supports `apk_access_…`, legacy `apk_live_…`,
and organization keys `apk_org_live_…`. Organization keys need `sources:read`
for the initial check, plus the permissions required by subsequent operations.
Each HTTP request validates the credential with Gateway v2's authenticated
`GET /v2/sources?limit=1`; this makes no provider purchase. Redirects are refused
and revoked/expired credentials are not cached. Access tokens stored as static
bearer credentials are not automatically refreshed: prefer DCR for user access.

This adapter must be deployed before the new bearer path is available on the
public server. OAuth remains the recommended setup.

## Verify in the workspace

Start with AI Playground: add the external Apiosk MCP and ask it to call
`apiosk_sources` with `limit: 1`. Check the actual tool call and result.

For a repeatable test, install the libraries from the
[Databricks Python guide](https://docs.databricks.com/aws/en/agents/custom-agents/use-mcp-tools),
authenticate the Databricks SDK, and use the URL shown on your MCP service:

```bash
python -m pip install databricks-mcp databricks-sdk 'mcp>=1.24,<2'
databricks auth login --host https://YOUR-WORKSPACE --profile DEFAULT
export DATABRICKS_MCP_SERVER_URL='https://YOUR-WORKSPACE/ai-gateway/mcp-services/CATALOG.SCHEMA.apiosk'
python examples/databricks_smoke.py
```

The script requires all six agent tools, rejects an exposed approval tool,
and calls only `apiosk_sources`. It checks for tool errors and a valid catalog
response; it prints counts rather than credentials or source records.

Then validate one intended business workflow in AI Playground: prepare a
request, inspect the returned approval link and ceiling, approve it yourself,
and read the resulting task. Run that purchase test only with a chosen budget.
Confirm a second status read reuses the saved result. Record the workspace,
service name, deployed MCP revision and outcome for the partner review.

## Marketplace handoff

The [partner validation process](https://databrickslabs.github.io/partner-architecture/data-collaboration/mcp-marketplace-validation)
requires a Data Partner account, a working workspace demonstration, Partner
Engineering review and publishing enablement. After publication, install the
listing into a fresh connection and repeat the tool test.

Suggested listing fields, following the
[MCP listing documentation](https://docs.databricks.com/aws/en/marketplace/create-listing#mcp-server-listing-fields):

| Field | Draft |
| --- | --- |
| Name | Apiosk External Data for AI Agents |
| Product | MCP server |
| Category | AI |
| Short description | Access specialist external data with explicit spending limits and source-backed results. |
| Server URL | `https://mcp.apiosk.com/mcp` |
| Authentication | Dynamic Client Registration |

Description: Connect Databricks agents to specialist external information
through Apiosk. Browse sources, prepare data requests, review the total ceiling,
and retrieve source-backed results. Purchases use the connected Apiosk account
and its approval rules; saved results can be read again without repurchase.
An Apiosk account and sufficient balance are required for paid requests.

Before publishing, supply the approved public documentation, privacy and terms
URLs and the provider profile. This file is a preparation guide, not evidence
of Marketplace approval or a published listing.

## Validation boundary

The local `test/databricks-http.test.mjs` starts the real HTTP server against a
fixture gateway. It covers DCR, a Databricks-shaped redirect, PKCE, refresh,
authenticated MCP initialization, tools/list, tools/call, JSON result parity
and revoked bearer credentials. The upstream login and data are simulated.

Real Databricks workspace authentication, proxy behavior, AI Playground and
Marketplace installation still require the workspace test above. Public OAuth
metadata and an HTTP 401 challenge alone do not establish that end-to-end flow.
