# Local MCP test — 2026-10-21

## Follow-up status

The full source-to-email test is still **blocked**, not passed. A read-only
inspection through the connected Supabase tool now confirms that all four monitor
tables, RLS, runtime grants and deduplication indexes exist in the database used
by the local Gateway. No schema change was made during this follow-up. The
previous statement below that the migration still needed installation is stale.
KVK profile, OpenSanctions company screening and Tavily search contracts are
present and active; catalog metadata is not proof of provider execution.

The selected companies and recipient are saved privately under
`mcp/.local/company-monitor/config.json`; retry identity is in `state.json`.
The connected Gmail account matches the requested recipient. No email was sent.
The actual acceptance command currently exits 2 with `local_mcp_token_missing`.
Local TCP bind also returns `EPERM` in the managed sandbox, and the running HTTP
MCP startup log still reports the older seven-tool process.

Fixed: an unreported potential screening match now retains its original evidence
through a later failed source run, marked historical, without claiming current
coverage. Missing storage and old HTTP routes now produce distinct error codes.
Validation: 23 Gateway company-check tests, 58 focused MCP/driver tests and the
PGlite storage check pass; Gateway compile check passes. The driver tests use
fixtures and are not live acceptance evidence.

## Resumable live acceptance

From an authenticated terminal with local network access, after loading current
Gateway/MCP code and enabling approved local execution:

```sh
cd /Users/olivier/Documents/Apiosk/Production/Main/mcp
node examples/run-company-monitor-local.mjs \
  --config .local/company-monitor/config.json \
  --state .local/company-monitor/state.json
```

Supply `APIOSK_CONNECT_TOKEN` through the process environment, never chat or the
state file. Reuse the same state file after approval, completion or a lost reply.
The script starts the production MCP child, creates/reuses one occurrence, reads
all saved evidence through MCP and prepares a durable email. It never approves
a price or sends email. Every incomplete step exits 2 and `accepted:false`.
The exact payload and dispatch permission are in the private state file.

Only after the authorized host email connector returns a successful send receipt,
save `{delivery_id, recipient, sent:true, provider, provider_message_id}` privately
and rerun with `--receipt <path>`. Do not use a draft or fabricate a receipt. The
driver confirms that receipt, reopens the saved result and verifies both same-ID
replay and a second prepare cannot send the same signals again.

An accepted result covers source evidence, the host-attested receipt and replay
of that saved report. It explicitly does **not** prove another week's fresh source
execution, native host scheduling or installation in both Claude and ChatGPT.
Those checks remain required; fixture tests or a successful MCP handshake do not
replace them.

## Earlier read-only probe

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
