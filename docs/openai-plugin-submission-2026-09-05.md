# Apiosk OpenAI plugin submission — version 1.8.0

This is the source of truth for the next OpenAI Plugins draft. It covers the
current eleven-tool MCP surface and the bundled `apiosk` skill. Do not reuse the
rejected 1.0.0 draft without scanning the deployed 1.8.0 server again.

## What to create

Choose **With MCP**. Use the universal production endpoint:

`https://mcp.apiosk.com/mcp`

After 1.8.0 is deployed, select **Scan Tools**. The scan should find all eleven
tools and import one skill through `io.modelcontextprotocol/skills`. The skill
is also packaged in `plugin/apiosk/skills/apiosk` for a skill-only upload.

## Listing metadata

- Display name: `Apiosk`
- Short description: `Find and run the right API`
- Developer: `Apiosk`
- Category: `Productivity`
- Website: `https://apiosk.com`
- Support: `https://apiosk.com/contact`
- Privacy: `https://apiosk.com/privacy`
- Terms: `https://apiosk.com/terms`
- Brand color: `#6349DB`

Long description:

> Apiosk finds API services for a request, compares price and measured
> performance, shows the exact cost before purchase, and runs the provider the
> user approves. It supports quick one-call answers and multi-step research
> plans. The connected Apiosk account controls balance, limits, and approval
> policy.

Capabilities:

1. `Discover APIs for a task`
2. `Compare providers by price and performance`
3. `Run user-approved API calls`

Starter prompts:

1. `Find the best API for current company information and show me the price.`
2. `Compare APIs that can extract text from a receipt.`
3. `Plan the API calls needed to research a company before spending anything.`

## Tool annotations and justifications

Every tool explicitly sets `readOnlyHint`, `destructiveHint`, and
`openWorldHint`. Copy these justifications into the review form.

| Tool | readOnly | destructive | openWorld | Justification |
| --- | --- | --- | --- | --- |
| `apiosk` | true | false | true | Reads the external Apiosk catalogue and quotes one provider; it does not purchase or mutate state. |
| `apiosk_connect` | true | false | false | Reads the current connection, balance, and policy; it does not call a provider or change the account. |
| `apiosk_discover` | true | false | true | Searches the external Apiosk and x402 catalogues; it does not purchase or mutate state. |
| `apiosk_compare` | true | false | true | Reads external provider offers and measurements; it does not purchase or mutate state. |
| `apiosk_execute` | false | true | true | Calls an external provider and charges the connected balance after explicit user approval. Repeating it can create another charge. |
| `apiosk_approval_status` | true | false | false | Reads the state of an existing approval and does not modify it. |
| `apiosk_plan` | false | false | true | Creates and stores an external research plan and signed quote; it dispatches no provider calls and spends nothing. |
| `apiosk_execute_plan` | false | true | true | Starts external provider work and can charge the connected balance, bounded by the approved signed plan. |
| `apiosk_job_status` | true | false | false | Reads an existing job and its events without changing or dispatching work. |
| `apiosk_resolve_job` | false | false | true | Records the user's selected identity and resumes an existing external job; it spends nothing itself. |
| `apiosk_cancel_job` | false | true | true | Stops future dispatches for an external job. Already dispatched calls remain settled. |

## Positive tests — exactly five

1. **Quick provider quote**  
   Prompt: `Find the best API for the latest filed annual accounts of Coolblue B.V. Show the price and do not buy yet.`  
   Expected: `apiosk` returns one runnable provider, exact buyer price, required inputs, signed offer token, and an approval choice without executing it.

2. **Compare alternatives**  
   Prompt: `Compare APIs for extracting text from a receipt. Optimize for reliability and keep the price below $0.10 per call.`  
   Expected: discovery/comparison returns named candidates with prices, measured performance, scoring inputs, and no charge.

3. **Approved single execution**  
   Prompt: `Use the provider I approved to run this receipt OCR request.`  
   Expected: `apiosk_execute` receives the unchanged signed offer token and exact inputs, performs one call, reports the result and charged amount, and is not retried automatically.

4. **Research plan**  
   Prompt: `Plan how to retrieve a Dutch company's profile and latest filed accounts. Price the complete job before doing anything.`  
   Expected: `apiosk_plan` returns ordered steps, reachable outputs, one total ceiling, and a signed plan token without spending.

5. **Durable research result**  
   Prompt: `Start the research plan I approved, then report its status and final result.`  
   Expected: `apiosk_execute_plan` starts one idempotent job; `apiosk_job_status` follows it to a terminal state and the final answer is grounded in the returned result.

## Negative tests — exactly three

1. **Attached local file**  
   Prompt: `Summarize the PDF I attached to this conversation.`  
   Expected: Apiosk is not invoked because the answer is already in the conversation.

2. **Writing task**  
   Prompt: `Rewrite this paragraph in a friendlier tone.`  
   Expected: Apiosk is not invoked because rewriting supplied text does not need an API provider.

3. **Calendar request**  
   Prompt: `What meetings do I have tomorrow?`  
   Expected: Apiosk is not invoked because it does not access the user's calendar.

## Release notes

Version 1.8.0 adds the OpenAI MCP skills extension, imports the bundled Apiosk
workflow during Scan Tools, corrects mutation and external-side-effect
annotations for job resolution and cancellation, includes the plan approval
card in the server card, and preserves the existing eleven tool names and input
contracts.

## Required portal evidence

- Deploy 1.8.0 before scanning. Production 1.7 does not implement
  `skills/list` and cannot import the skill.
- Complete developer or business identity verification for Apiosk.
- Complete the domain challenge at
  `https://mcp.apiosk.com/.well-known/openai-apps-challenge` using the exact
  portal token.
- Provide a reviewer account with a funded but tightly capped balance, no 2FA
  dependency, and enough sample data to exercise all tools.
- Provide a demo recording URL that shows connection, quote, approval, a
  successful one-call result, a research plan, and job status.
- Because the MCP provides custom UI and there are three starter prompts,
  upload exactly three screenshots, one per prompt, each 706 pixels wide and
  400–860 pixels tall.
- Rescan after every change to tool definitions, annotations, skill content, or
  MCP metadata.

## Public-review policy risk

OpenAI's current plugin guidelines allow sign-in to an existing paid account,
but prohibit selling digital products or services, including credits, directly
or indirectly through a plugin. Apiosk's pay-per-request execution is a digital
service and the tools show a price before consuming the user's existing
balance. This is a real public-listing risk that code cannot remove without
changing the product flow. It does not prevent private installation as a custom
MCP or local skill. Get a written classification from OpenAI developer support
before resubmitting the public listing, and include the answer in the reviewer
notes.
