# Settlement rails — USDC, SEPA incasso, credits

Apiosk is **one mandate, any rail**. A single buyer connect token can settle a
paid API call over any of three rails. The gateway picks the rail per call —
the agent does not need to know or choose which one is used.

| Rail | What it is | Best for |
| --- | --- | --- |
| `usdc_x402` | On-chain USDC on Base (chain `8453`), settled per call via an x402 payment proof from the agent wallet or `APIOSK_PRIVATE_KEY`. | Crypto-native agents with a funded wallet. |
| `sepa_incasso` | EU **SEPA Direct Debit** (incasso). Paid calls are appended to a ledger and collected later in batches from the buyer's bank account. No per-call bank transaction. | EU buyers; high call volume; lowest fees. |
| `credits` | Prepaid balance topped up once by a human (Adyen/Mollie), then spent down per call (`apiosk_buy_credits`). | Humans who want to pre-fund and let an agent spend. |

### Rail fallback order

1. **USDC / x402 wallet** — when the agent can produce a payment proof.
2. **SEPA incasso ledger** — when the buyer has an active SEPA mandate. No proof
   needed: the call is *recorded*, not blocked.
3. **Prepaid credits** balance.

A `402 Payment Required` is only returned when none of the buyer's enabled rails
can cover the call.

---

## SEPA incasso (direct debit), end to end

An incasso lets Apiosk pull euros from the buyer's bank account under a one-time
mandate, so an agent can keep calling paid APIs without signing or funding each
call.

### 1. Mandate setup — once, by a human

In the buyer portal the buyer authorizes a recurring SEPA mandate:

- **iDEAL** (NL): a one-cent verification payment returns a reusable
  direct-debit mandate. Recurring calls then use `method=directdebit`.
- **PayPal** / **card**: alternative mandates for non-NL buyers (recurring calls
  use `method=paypal` / `method=creditcard`).

Agents never perform this step — they only need the connect token afterward.

### 2. Collection terms — once, by the buyer

The mandate authorizes bounded collection:

- **Threshold:** €25–€500 (default €25, floor €25).
- **Max age:** 7, 14, or 30 days.

These bound how much, and for how long, calls can accrue before a collection is
triggered.

### 3. Per call — automatic, deferred

When a paid call settles over SEPA, the gateway appends a **SEPA ledger debit**
row carrying the full breakdown and returns success immediately:

```json
{
  "total_eur": "0.10",
  "apiosk_fee_rate": "0.03",
  "apiosk_fee_pct": "3.0000",
  "apiosk_fee_eur": "0.003",
  "provider_net_eur": "0.097"
}
```

No bank transaction happens yet — only a ledger entry.

### 4. Batch collection — background worker

A worker flushes a buyer's unbatched ledger into **one** Mollie SEPA Direct
Debit when either condition is met:

- outstanding (unbatched) sum **crosses the threshold**, OR
- the **oldest unbatched entry passes the max age**.

Many micro-calls collapse into a single bank debit. The worker opens a batch via
the `sepa_open_settlement_batch` RPC and calls the `mollie_settle_sepa_batch`
edge function to create the direct debit.

---

## Economics

- **Apiosk platform fee: 2% by default** of each call's gross, recorded per ledger row.
- **Mollie SEPA Direct Debit fee: ~€0.30 per collection (per batch)** — not per
  call. This is why sub-€25 thresholds are not offered: batching amortizes the
  fixed bank fee across many calls.
- The provider receives gross minus the Apiosk platform fee; the Mollie fee is netted
  at collection time.

## Operational defaults

| Setting | Default | Env / source |
| --- | --- | --- |
| Buyer threshold | €25 (range 25–500) | buyer portal, `sepa_collection_threshold_eur` |
| Buyer max age | 7 / 14 / 30 days | buyer portal |
| Batch worker cadence | 1800 s | `SEPA_BATCH_POLL_SECONDS` |
| Batch flush amount | €25 | `MOLLIE_BATCH_FLUSH_EUR` |
| Batch flush age | 7 days | `MOLLIE_BATCH_FLUSH_DAYS` |

## Connect string and SEPA

The connect string identifies the buyer's managed wallet and connect token:

```bash
export APIO_GATEWAY_URL=https://gateway.apiosk.com
export APIO_CHAIN_ID=8453
export APIO_AGENT_WALLET_ADDRESS=0x...
export APIO_CONNECT_TOKEN=aw_...
export APIO_CONNECT_AUTHORIZATION=Bearer aw_...
export APIO_CONNECT_HEADER_NAME=X-Apiosk-Connect-Token
# Optional USDC-rail guardrails:
export APIO_WALLET_DAILY_LIMIT_USDC=100
export APIO_WALLET_PER_TX_LIMIT_USDC=1
```

The `APIO_WALLET_*` limits only bound the **USDC** rail. The **SEPA mandate and
its threshold/age terms live server-side** against the same buyer account, so the
identical connect token transparently settles over SEPA incasso when USDC is
unavailable — no extra connect-string fields are required. An agent holding only
this connect token can therefore make paid calls with no on-chain balance; those
calls land on the SEPA ledger and are collected in the next batch.

## Agent guidance

- Agents do **not** set up the mandate — that is a one-time human action in the
  buyer portal.
- SEPA-backed calls succeed immediately even with no wallet balance and no x402
  proof; settlement is deferred to the batch.
- Inspect outstanding (unbatched) SEPA balance and upcoming collections via the
  buyer portal or `apiosk_get_credits_status`.
- For the machine-readable version of this doc, call `apiosk_help` with
  `topic="rails"`.
