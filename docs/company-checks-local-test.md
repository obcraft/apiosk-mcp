# Local MCP test — 2026-10-21

Tested a fresh child process running the production `mcp/index.mjs`, using the
MCP SDK client and stdio transport. No in-memory replacement of the MCP server.

| Check | Outcome |
|---|---|
| MCP initialization and monitoring instructions | Passed |
| `tools/list` | All five company-monitoring tools returned |
| Host contract resource | Passed |
| Claude resource | `text/html;profile=mcp-app`, loaded |
| ChatGPT resource | `text/html+skybridge`, loaded |
| Actual `apiosk_company_check_read`, no token | OAuth challenge, `unauthorized` |
| Same read with an intentionally invalid local probe token | `company_check_unconfirmed`; sandbox cannot reach the local Gateway |
| Focused MCP tests | 52 passed |
| Isolated PostgreSQL storage check | Passed using the real migration/runtime SQL in PGlite |
| Paid source execution / email / host schedule | Not performed |

The test token was deliberately invalid and used only for a read-only,
nonexistent-check probe. No credentials were printed or saved. Both localhost
health requests failed from this sandbox, while `lsof` showed existing listeners
on 8082 and 3000. The current MCP startup log reported the original seven tools;
the fresh stdio process reported the five additional monitoring tools.

This is **not** a passed source-to-email end-to-end run. The local stdio account
token is not configured, the sandbox cannot reach localhost, and the existing
HTTP process needs the new code loaded. The monitor migration must also be
installed in the target database before testing its storage through Gateway.
The ordinary local launcher uses the configured Supabase database; it is not an
isolated local database and must not be treated as one.

Read-only reproduction from a terminal with localhost access:

```sh
node /Users/olivier/Documents/Apiosk/Production/Main/mcp/examples/check-company-monitor-local.mjs
```

Use the existing authenticated MCP setup, or an `APIOSK_CONNECT_TOKEN` supplied
securely through the process environment. Do not paste credentials in chat. The
script prints only tool/resource metadata and error codes, never the token. It
exits with code 2 when the Gateway read is blocked, even when MCP initialization
passes. An unknown-check probe may also return a not-found error; that is not a
completed monitoring test. A full run still needs identified companies and a
confirmed host mail/schedule setup under the existing spending approval rules.
