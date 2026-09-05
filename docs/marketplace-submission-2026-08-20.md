# Superseded

The current OpenAI Plugins submission plan is
[`openai-plugin-submission-2026-09-05.md`](./openai-plugin-submission-2026-09-05.md).
This file describes the retired six-tool surface and must not be used for a new
submission.

# Apiosk Connect — ChatGPT App Directory submission

Supersedes `marketplace-submission-2026-04-08.md`, which still described the
publisher and local-wallet tools removed on 2026-08-19 (see `../CLAUDE.md`).
The current server exposes exactly six tools; this doc describes only those.

## Open risk — read before submitting

OpenAI's Apps SDK submission guidelines (`developers.openai.com/apps-sdk/app-submission-guidelines`)
state, in the commerce section:

> "Selling digital products or services — including subscriptions, digital
> content, tokens, or credits — is not allowed."
> "Execution of money transfers, crypto transfers, or investment trades" is
> prohibited.
> "Currently, plugins may conduct commerce only for physical goods."

`apiosk_execute` pays for a digital API call. Read literally, that is the
commerce category the policy excludes. The guidelines do not address the
specific shape this server has — an agent paying a *third-party* provider on
the buyer's behalf, where no crypto transfer is constructed or executed inside
the plugin process at all:

- `apiosk_execute` makes one authenticated HTTPS `POST /v1/do` to
  `gateway.apiosk.com` ([src/tools/execute.mjs](../src/tools/execute.mjs)).
  No wallet key, no transaction signing, no x402 payload construction happens
  in this repository or in the ChatGPT tool-call boundary.
- The MCP server holds no keys and moves no money — stated to every
  connecting client in `SERVER_INSTRUCTIONS`
  ([src/create-server.mjs:51](../src/create-server.mjs)) — because it
  genuinely cannot: settlement is a property of the gateway, a separate
  service.
- The buyer never sees "crypto." Onboarding at buy.apiosk.com funds a
  euro-denominated balance; USDC/x402 is the rail Apiosk chose to pay
  upstream providers, not something exposed to the end user or to ChatGPT.
- Functionally this is closer to metered API-usage billing (a cloud
  provider charging per call against a prepaid balance) than to an in-chat
  storefront, subscription upsell, or crypto exchange.

That argument is real but untested against actual review judgment — the
published text doesn't carve it out explicitly. **Ask OpenAI developer
support this question directly, in writing, before or alongside submitting**,
rather than assuming the framing below will be accepted on first pass:

> "Our MCP server calls our own backend API, which settles payment to a
> third-party provider server-side. No crypto transfer is constructed or
> signed inside the plugin/MCP process. Does this fall under the 'selling
> digital products/executing crypto transfers' restriction, or under normal
> metered API billing?"

## Plugin name

`Apiosk Connect` — confirmed free; see chat history. (`Apiosk` bare was the
first choice but an earlier install may still be occupying it — verify before
switching.)

## Description

Short (matches `SERVER_DESCRIPTION`, [src/create-server.mjs:24](../src/create-server.mjs)):

> Buy an API call the way a person would: describe the job, see what can do
> it, compare the candidates on price and measured performance, choose one,
> and pay for it in USDC under limits you set. The buyer sets the rules at
> buy.apiosk.com; the gateway enforces them on every call.

Long:

> Apiosk Connect gives ChatGPT a comparison layer for paid APIs. Describe a
> job in plain words; it sweeps the reviewed Apiosk catalogue and the wider
> x402 ecosystem, prices and scores the candidates on measured latency and
> success rate, and lets you choose before anything is paid. Once you pick,
> it runs that exact offer under the price ceiling you saw. Every spending
> rule — per-transaction limits, daily caps, approval thresholds — is set by
> the buyer at buy.apiosk.com and enforced by the gateway, never by the
> model.

## Category

Developer tools, AI agents, API marketplace. Leave "Payments" off the
category list until the commerce question above is answered — self-labeling
as a payments app invites exactly the scrutiny this doc is trying to get
ahead of.

## Hosted endpoint

`https://mcp.apiosk.com/mcp` (Streamable HTTP). Legacy SSE at `/sse` for
older clients.

## Tool surface (current — six tools, in flow order)

| Tool | Spends money | Behind OAuth | Annotations |
| --- | --- | --- | --- |
| `apiosk` | No | Yes | readOnly, idempotent, openWorld |
| `apiosk_connect` | No | No | readOnly, idempotent |
| `apiosk_discover` | No | Yes | readOnly, idempotent, openWorld |
| `apiosk_compare` | No | Yes | readOnly, idempotent, openWorld |
| `apiosk_execute` | **Yes** | Yes | destructive, non-idempotent, openWorld |
| `apiosk_approval_status` | No | Yes | readOnly, idempotent |

Descriptions and schemas are defined once in `src/tools/*.mjs` and are the
source of truth — do not restate them by hand in the submission form if it
allows pulling from `/.well-known/mcp/server-card.json`; paste-and-drift is
how the welcome page went stale (see the `2026-08-20` welcome-page fix
commit).

Tool annotations already satisfy the "properly label readOnlyHint,
destructiveHint, openWorldHint" requirement — verified against
`src/tools/*.mjs`, no changes needed there.

## Test / demo account for reviewers

OpenAI requires "a fully featured demo account that includes sample data."
This needs a decision, not code:

- Point reviewers at the **staging gateway** (`APIOSK_GATEWAY_URL` override,
  documented in `smithery.yaml`) with a pre-funded test wallet and a connect
  token that has generous limits, so `apiosk_execute` can actually be
  exercised end to end without spending real funds.
- Or provide a funded mainnet demo wallet with a small, capped balance.

Action item, not something this doc can fill in: mint that token/wallet and
paste connect_url + credentials into the submission form once decided.

## Privacy, terms, support

- Privacy policy: `https://apiosk.com/privacy/` (200, live)
- Terms: `https://apiosk.com/terms/` (200, live)
- Support contact: `olivier@apiosk.com` (public in `landingpage/README.md`)
- Security disclosure: `security@apiosk.com`, also served at
  `mcp.apiosk.com/security/settlement-contract` with the on-chain settlement
  contract address, current fee, and what the USDC approval permits
  ([src/settlement-disclosure.mjs](../src/settlement-disclosure.mjs)).

## Developer verification

OpenAI requires identity confirmation through the OpenAI Platform Dashboard.
This is an account-level action only the account owner can complete — do it
before submitting; it's also what fixes the placeholder "App developer /
Other" shown on the current custom-connector install screen.

## Install (works today, no App Directory needed)

```bash
claude mcp add --transport http apiosk https://mcp.apiosk.com/mcp
```

ChatGPT today: Settings → Apps & Connectors → Advanced → enable Developer
Mode → Add custom connector → URL above, Authentication: OAuth. This
friction (the Developer Mode toggle) is exactly what App Directory listing
removes for other users — it's the reason this submission exists.
