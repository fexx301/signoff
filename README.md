# Signoff

**Check what your agent is about to pay for before Passport pays.**

A Kite Passport session caps *how much* an agent can spend. It doesn't check what the agent is actually being charged, who receives the money, or whether the call serves what you asked for. Signoff runs those checks before every payment.

Built for SERV Hackathon 02, Kite track. It uses SERV Reasoning for intent checks and Kite Passport for payments.

## Demo (1:25)

[![Signoff demo: Kite lists an endpoint at $0.001; Passport paid $0.002 on Base. Click to watch the 1:25 demo on YouTube.](media/signoff-demo-poster.jpg)](https://youtu.be/9GDkkxlrAGA)

[Watch the demo on YouTube](https://youtu.be/9GDkkxlrAGA), or download the [MP4](media/signoff-demo.mp4) (11 MB). It shows a real 2× charge that plain Passport paid on Nov 3, then a live run on Nov 4: the same call refused, an off-intent request refused by SERV, and a clean paid call with its receipt. Every terminal line in the video is real output, with cuts marked `⋯`.

## The problem, measured on Kite's own catalog

Kite's discovery catalog lists each paid endpoint with a price and a state (`works`, `untested` or `broken`). Agents plan with those listed prices. The payment itself is whatever the endpoint's live `402 Payment Required` asks for, and Passport pays it as long as it fits under the session cap.

On 2026-11-03 and again on 2026-11-04, we sent unpaid requests to a 343-endpoint keyword sample of the catalog and compared each live payment request with its listing:

- **24 of 165 endpoints marked `works` asked more than their listed price**, mostly 2× and up to 10× (app.tenna.ai: $0.10 against a listed $0.01).
- Endpoints marked `untested` asked up to **$10 against a listed $0.022** (stablestudio, 455×) and **$2 against $0.005** (stableupload, 400×). Both use the fixed `exact` payment scheme.
- One endpoint marked `works` answered `410 Gone` ("retired").
- **Plain Passport paid a 2× charge silently.** Two sitecheck endpoints listed at $0.001 charged $0.002 each, with no warning:
  - [`0x45ea39ec…21fb`](https://basescan.org/tx/0x45ea39ec465d54a627fd86df1317c971a5d69cc034e01d9a981ca2eb919321fb)
  - [`0xa19a865d…35a8`](https://basescan.org/tx/0xa19a865dff80bccb65f12747c1b7a4718c5944b6b8b20925c0604cb5729835a8)
- The catalog records no expected payee, so Passport pays whatever `payTo` address the live 402 names.

These are small amounts today. The point is structural: nothing between the listing and the signature compares them.

Reproduce it yourself for free; no wallet is needed:

```sh
npm ci
npm run guard -- report
```

## What Signoff checks

`check` sends the request unpaid and reads the payment terms. `pay` runs the same check and pays through your Passport session only if the decision is `ALLOW`.

| Check | Decision | Why |
|---|---|---|
| Live price above the listed price (beyond `--slippage-bps`) | `REFUSE price_drift` | You planned for the listing, not the live price |
| Live price above `--max-usd` | `REFUSE over_budget` | Your per-call limit |
| `payTo` differs from the payee pinned on first successful use | `REFUSE payee_changed` | Trust on first use, like SSH `known_hosts` |
| Endpoint answers `410 Gone` | `REFUSE retired` | |
| No USDC-on-Base option | `REFUSE wrong_asset` | |
| SERV: this endpoint or this exact request doesn't serve the intent | `REFUSE off_intent` | Arithmetic can't tell a translation API from a sentiment API |
| SERV unsure, or SERV unavailable | `HOLD intent_unclear` | Fails closed |
| Unpaid `404` or `5xx`, variable-price scheme, or unlisted price | `HOLD` | Not proof of a problem; a person decides |

Every decision writes a receipt to `.signoff/receipts/` with:
- the listing and its hash;
- the live terms;
- the reasons for the decision;
- the SERV verdicts and the quotes they rest on;
- if paid, the Base transaction and a hash of the reply.

After a payment, SERV also checks whether the reply satisfies the intent. That verdict is recorded on the receipt.

## How SERV is used

SERV Reasoning makes the two judgements the arithmetic can't:

1. **Before paying:** does this endpoint, called with this exact request, serve the user's intent?
2. **After paying:** does the reply satisfy it?

Both calls use a strict JSON schema with three verdicts: `yes`, `no` or `unsure`. A `yes` or `no` must quote an exact substring of the request or reply. Otherwise Signoff downgrades it to `unsure` and holds the payment.

Live examples from 2026-11-04 (`gpt-5.4-mini` via SERV):

| Intent | Request | Result |
|---|---|---|
| "Convert the hex value ff to decimal" | base-convert, `from:16, to:10` | ALLOW. Paid [`0x210b1a2f…f2b7`](https://basescan.org/tx/0x210b1a2f23e6f9859685d9d7018f22f425c327fbabfb270283b7a8308de4f2b7); the reply check confirmed "255" |
| same | base-convert, `to:2` | REFUSE off_intent, quoting `"to":2` |
| "Is this review positive or negative?" | a translation endpoint | REFUSE off_intent: wrong job |
| "Weather in Lagos this week" | weather at `lat=52.52&lon=13.405` (Berlin) | REFUSE off_intent, quoting the coordinates |

## How Kite Passport is used

- **Payments:** `pay` calls `kpass session execute` in a passkey-approved Passport session, which enforces the per-call and total caps. Signoff decides whether that call should happen at all.
- **Endpoint data:** listings, prices and catalog states come from Kite's discovery catalog through `ksearch`.

## Quick start

Requirements: Node 24, plus the `ksearch` and `kpass` CLIs (Kite Passport).

```sh
npm ci
cp .env.example .env.local      # set SERV_API_KEY for intent checks

# Free: compare one endpoint's live terms with its listing
npm run guard -- check 064eadae0eb4a78c7864f5f3 --body '{"value":"ff","from":16,"to":10}' \
  --intent "Convert the hex value ff to decimal"

# Pays only on ALLOW. PASSPORT_DIR is the folder holding your Passport login
# and an approved session (kpass session create ...).
PASSPORT_DIR=~/my-passport npm run guard -- pay 064eadae0eb4a78c7864f5f3 \
  --body '{"value":"ff","from":16,"to":10}' --intent "Convert the hex value ff to decimal"

# Free catalog-wide drift report
npm run guard -- report
```

Options:
- `--max-usd` sets the per-call limit (default 0.02).
- `--slippage-bps` sets the allowed price drift above the listing (default 0).
- `--query` and `--body` override the listing's example input.

Exit codes: `0` allowed or paid, `2` refused, `3` held, `1` error.

## Evidence in this repo

`evidence/` holds the 2026-11-04 drift report and the guard's receipts: the allowed paid calls and the refusals. Raw catalog data comes from Kite's public discovery service, and transactions can be checked on Basescan.

`scripts/audit-probe.ts` and `scripts/free-audit.py` are the research scripts behind the first measurements. `scripts/arbiter-probe.ts` records a probe of Kite's agreement runtime. On dev it answered that the agreement surface is not yet live.

## Limits

- **Small samples.** The catalog numbers come from a keyword sample (343 endpoints), checked once per run. Prices can change legitimately; the finding is that listings go stale, not that any seller misbehaved.
- **Re-fetch window.** `kpass` re-fetches the 402 just before signing. If the price moves between Signoff's check and the payment, the receipt flags it (`paidDiffersFromChecked`) but cannot prevent it. Closing that window needs Passport to accept a pinned amount and payee.
- **Payee pins are stored locally** in `.signoff/pins.json`. A first use is trusted by definition.
- **Limited SERV evidence.** The intent checks are LLM judgements bound to quoted evidence. They hold when unsure, but they are not proven against adversarial inputs.
- **Paid checks are narrow.** Twenty paid audit calls found no endpoint that returned wrong output for its listing, so Signoff does not claim sellers deliver bad work.

## Repository history

This branch (`escrow-prototype`) keeps the shelved prototype. Its test fixtures deliberately contain prompt-injection text (a note addressed to an "automated reviewer") to prove the verifier rejects it; each is labelled as adversarial test input in the code.

The first commits are an earlier prototype: a custodial acceptance-escrow processor (`src/server.ts`, `src/jobs.ts` and related files). It was shelved because Passport could not pay a custom host and Kite runs its own escrow runtime. That code still runs and its tests still pass, but it is not part of the guard.
