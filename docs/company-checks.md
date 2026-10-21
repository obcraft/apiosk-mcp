# Company monitoring in Claude and ChatGPT

Demo instruction:

> Volg bedrijf X, Y en Z. Controleer iedere maandag op wijzigingen in
> bedrijfsgegevens, mogelijke vermeldingen op sanctielijsten en relevante
> nieuwsberichten. Mail me alleen nieuwe signalen, met bronnen.

X, Y and Z are placeholders, not identified companies. Resolve real names to
exact KVK numbers using the existing Apiosk lookup and choice flow. Do not guess
an ambiguous company. No CSV or outstanding balance is needed.

## Initial setup

1. Call `apiosk_company_check` with a new UUID `check_id`, a stable `occurrence`,
   and one to three `{name, kvk_number}` objects. Record IDs before calling.
   The original ten-source-call limit still applies; missing capabilities remain
   explicit gaps. A different company list needs a new check ID.
2. Follow the returned existing task actions and price/approval card. The host
   can use an already configured connection spending rule; the monitoring request
   does not itself create or widen that rule.
3. After execution call `apiosk_company_check_result`. It saves original evidence,
   compares supported fields, and returns `new_signals`. The first KVK profile
   establishes a baseline. Potential screening matches require manual identity
   review. News mentions require relevance/identity review and carry source URLs
   and publication dates; they are not verified adverse events.
4. For requested email, confirm the user's own destination address and that the
   host has an authorized email connector that can send in scheduled tasks.
   A generic task-completion notification is not the requested email.
5. If there are new signals, persist a new UUID `delivery_id` and call
   `apiosk_company_check_email` with that ID and the saved check/occurrence IDs.
   Only when `dispatch_allowed=true`, send its exact plain-text subject/body once
   through the host mail connector. Do not send a no-change or all-clear email.
6. After the connector returns a successful-send message ID, call
   `apiosk_company_check_acknowledge` with `check_id`, `delivery_id`, `provider`
   and `provider_message_id`. The receipt is a host attestation, not independent
   verification by Gateway. Never substitute a draft ID or a chat message ID.
7. Create the host's Monday scheduled task with the user's timezone and time,
   the saved check ID and these instructions. Verify that Apiosk, mail and needed
   permissions are available to that task. Confirm only the host's actual
   creation result. Do not also create an Apiosk recurring order.

## Repeat instruction

> Run `apiosk_company_check` for check_id `<saved UUID>`, omitting companies.
> Use the scheduled date in the chosen timezone as the occurrence key; retries
> reuse that key. Follow existing spending authorization and returned task
> actions. Collect `apiosk_company_check_result`. If new_signals is empty, send
> no email. Otherwise prepare `apiosk_company_check_email` with a saved new
> delivery_id. Send its exact subject/body to my verified address using the
> authorized email connector, once and only when dispatch_allowed is true.
> Confirm only a successful email receipt via apiosk_company_check_acknowledge.
> Report execution or delivery blockers in the host; never mail an all-clear
> when coverage is missing. Never buy again to reopen saved evidence.

## Retry and recovery

A lost purchase response uses the same check/occurrence IDs. A lost email-prepare
response uses the same delivery ID and will NOT grant a new dispatch. The host
must inspect the original connector action/result or sent-message record.
If it finds the successful receipt, confirm it. Do not automatically resend
following a timeout, crash or unknown outcome. A handoff with no recoverable
receipt stays blocked for operator reconciliation. This favors preventing
repeated emails over automatically retrying an unproven delivery.

`apiosk_company_check_read` reads history; add `occurrence` and `result_ref`
together to reopen original evidence. No purchase, delivery or acknowledgement
occurs on read. Reads, collecting and showing a card never mark signals emailed.
Checks are owner/workspace/connection scoped; another host connection cannot
silently take over a monitor.

## Evidence and host availability

Supported projections: exact KVK profiles, bound OpenSanctions responses and
bound Exa/Tavily result arrays with dates/links and an exact company-name phrase.
The stored task subject must bind to the requested KVK number. A same-name news
mention is explicitly not verified identity. Unsupported, truncated or failed
sources remain unknown; absence of results is not a clean bill of health.
News filters apply a seven-day window, exclude future/undated rows and deduplicate
canonical URLs across providers. Publication dates and retrieval dates stay
separate. Scores, tracking parameters and changed receipt IDs are not new events.

Host scheduling/card availability must be verified in the user's actual account:
[Claude scheduled tasks](https://support.claude.com/en/articles/13854387-schedule-recurring-tasks-in-claude-cowork),
[ChatGPT scheduled tasks](https://learn.chatgpt.com/docs/automations),
[ChatGPT MCP Apps UI](https://developers.openai.com/plugins/build/chatgpt-ui).
The news response shapes follow [Exa Search](https://exa.ai/docs/reference/search)
and [Tavily Search](https://docs.tavily.com/documentation/api-reference/endpoint/search).

Apply the Gateway migration, deploy Gateway then MCP, refresh installed hosts,
and verify actual source-to-email execution in each. Protocol tests and fixtures
are not proof of a deployed source, created schedule, purchase or delivered mail.

For a resumable local source/evidence/mail-receipt check through a fresh production
MCP process, use `examples/run-company-monitor-local.mjs --help` and the exact
steps in [the local acceptance report](company-checks-local-test.md). A missing
token, blocked connection, unfinished approval, partial coverage or missing mail
receipt is a blocked run, never a passed acceptance test.
