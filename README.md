# Signoff

Agent payments. Released on acceptance.

A buyer agent buys a brief from one configured automated seller. Signoff receives the payment through x402, holds the funds in its testnet processor wallet, and evaluates delivery against the frozen job policy. Accepted work pays the seller; rejected work refunds the buyer; uncertain results hold funds for review.

This is a custodial Kite-testnet prototype. The processor controls the wallet and the verifier policy. It is not trustless escrow. No mainnet support is enabled.

## What the acceptance check establishes

`brief-v1` checks section presence/order, word count, citation URL count, required terms, placeholder/reviewer-instruction patterns, and six SERV semantic criteria. SERV must return each expected criterion ID once with exact boolean types and verbatim artifact quotes for passing criteria. Missing, malformed, incomplete, or low-confidence semantic results do not release funds.

The semantic check evaluates relevance, audience, developed sections, terms, citation attribution, and reviewer-directed instructions. It does **not** fetch cited pages or establish factual accuracy. The live verifier probe includes a deliberately wrong answer to supplied fictional facts; passing that fixture does not establish general research correctness or prompt-injection resistance.

The configured automated seller accepts valid incoming specs under this published policy when a job is created, before payment settlement and generation. There is no multi-seller onboarding or negotiation UI. Job/spec and criteria hashes freeze the accepted inputs; completed receipts also hash the verifier verdict. Model/provider and simulation status remain visible.

## Setup

Use a Node runtime that supports `node:sqlite` (Node 24 is the tested runtime).

```sh
npm ci
cp .env.example .env.local
npm run setup:processor
```

If `.env.local` already exists, keep it instead of copying over it. `setup:processor` creates a dedicated testnet processor key if absent, sets the matching PAY_TO, keeps any existing SERV key, and prints only the public address. It writes the ignored secret file with mode 600. Never commit that file or share its private key.

Request testnet KITE for the displayed public address at the official faucet: https://faucet.gokite.ai/ . Network settings: https://docs.gokite.ai/kite-chain/1-getting-started/network-information . The chain is 2368; native KITE covers gas. Testnet pieUSD is the buyer payment asset and reaches the processor through an incoming paid job. Buyer/session funding is a separate integration step.

Set a SERV_API_KEY, a unique SELLER_SECRET, and a SELLER_PAYOUT_ADDRESS controlled by the demo seller. Dolphin is optional: the seller can use SERV instead. Failed live generation never silently falls back to a local mock.

### Offline development

Set all three switches together:

```text
DEV_SKIP_PAYMENT=true
DEV_MOCK_VERDICT=true
DEV_MOCK_PAYOUT=true
```

Then `npm run dev`. The page and receipts clearly label simulated runs. Mixed mock/live payment modes are rejected at startup, and funded-job guards also reject simulated inputs before live money movement. Development startup does not contact the facilitator.

### Live testnet run

Set all DEV_* switches to false and configure the processor key, matching PAY_TO, seller address/secret, SERV key, and public HTTPS base URL. Run `npm run probe` for access checks. The CLI/session custom-host payment path is **still unproven**. Do not treat an HTTP 402 challenge as evidence that a Passport session can pay it.

`npm run verify:serv` tests four fictional fixtures with a maximum of two verdict attempts per fixture (with one bounded repair for malformed verdicts). It signs no payment. Use `DB_PATH=:memory:` for an ephemeral probe; `SIGNOFF_ENV_FILE` optionally selects an existing local secret file. Do not publish credentials in output or screenshots.

`npm run demo -- --dry` prints a challenge and a proposed Passport command. Without `--dry`, a configured BUYER_PRIVATE_KEY enables an actual testnet payment; execute only when that test transaction is authorized. The seller's payout address must be controlled and checked before funding the run.

## Payment integrity and recovery

The job starts awaiting payment. Successful matching settlement is required before seller execution, delivery, and disposition. A signed payment is bound to one job/spec; replay returns that job rather than settling again. Incoming settlement errors leave `payment_pending` and never authorize a payout. An ambiguous incoming outcome requires manual chain/facilitator reconciliation; automatic incoming-payment recovery is not implemented. Do not blindly buy again.

A database compare-and-swap claims one disposition (payout or refund). The processor reserves its nonce in SQLite, signs the transaction, and stores the signed transaction and hash **before broadcast**. Retries reconcile or rebroadcast those exact signed bytes. Confirmation must report success and the expected token Transfer event before the job becomes released/refunded. Receipt timeouts remain `transferring`; the background sweep retries confirmation without rerunning the model or changing disposition. Reverted transfers and externally consumed nonces require manual reconciliation; automatic replacement transactions are deliberately unsupported.

Keep the database and processor key together. Do not share the processor wallet with another application or manually send from it: external nonce use can stall recovery. SQLite holds signed transactions, so keep the database private. Public API responses omit the raw transaction. A process restart holds interrupted seller/verifier work for explicit retry. Use one app process for this prototype; replicas and production-scale scheduling are out of scope.

Old prototype records cannot retroactively establish confirmed live payments. Use fresh jobs/database for the final demo; retain existing data as development evidence.

## Optional Reppo escalation

Appeals are allowed only while funds remain held and before any disposition is claimed. Deterministic policy failures cannot be overridden. One appeal is allowed per job. An exact normalized decision is required; free-text substrings and high scores cannot turn unknown/negative decisions into acceptance. Unknown results, provider failures, or appeal deadline expiry move the job to an explicit review hold. There is no automatic refund for uncertainty, and no public manual-release endpoint. An unresolved hold needs operator reconciliation.

Provider response mappings and end-to-end appeal settlement remain unverified against a live Reppo account. The API flow exists, but do not claim a working independent appeals system until its real result format and outcomes have been exercised.

## Checks and current evidence

```sh
npm test
npm run typecheck
npm run build
```

The regression suite covers funding guards, absent SERV credentials, complete verdict validation, concurrent appeal polls, durable transfer recovery, nonce persistence across database reopen, transaction confirmation/reverts, retries, HTTP seller authentication, simulated receipts, and payment replay. Provider/facilitator responses and transfers are mocked in automated tests. Test success is not evidence of a paid Kite job or live model reliability.

Outstanding: live custom-host payment, confirmed live payout/refund, broader verifier calibration, Reppo and optional Dolphin access, demo recording, public repo, and submission. External publishing and transaction execution need the builder's authorization.
