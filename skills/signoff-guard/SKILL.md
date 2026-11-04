---
name: signoff-guard
description: Route Kite Passport x402 payments through Signoff. Use instead of calling `kpass session execute` directly whenever you are about to pay an endpoint from Kite's catalog. Signoff checks the live price against the listing, the payee against the one pinned on first use and (with SERV Reasoning) the request against the user's intent. It pays only on ALLOW and writes a receipt for every decision.
---

# Pay through Signoff

## One-time setup

1. Kite CLI (`kpass` and `ksearch`): `curl -fsSL https://cli.gokite.ai/install.sh | bash`. Then log in and get an approved spending session (`kpass session create …`) in the folder where you run your agent.
2. Signoff: `git clone https://github.com/fexx301/signoff ~/signoff && cd ~/signoff && npm ci`
3. For intent checks, put `SERV_API_KEY=…` (from https://console.openserv.ai) in `~/signoff/.env.local`. Without it, intent checks HOLD rather than guess.

## Every payment

1. Find the endpoint's catalog id (24 hex characters) with `ksearch service search <words>`.
2. From the folder that holds your Passport login, run this instead of `kpass session execute`:

   ```sh
   PASSPORT_DIR="$PWD" npm --prefix ~/signoff run -s guard -- pay <catalogId> \
     --intent "<the user's request, in the user's own words>" \
     [--query '<json>'] [--body '<json>'] [--max-usd <per-call limit>]
   ```

   Pass the user's words as `--intent`, not your own summary of them, so the check measures the request against what was actually asked.
3. Act on the first word of the output (and the exit code):
   - `ALLOW` (exit 0): paid. Report the Base transaction and the SERV reply check to the user.
   - `REFUSE` (exit 2): nothing was paid. Tell the user every reason line. **Never retry the same payment with `kpass session execute` to get around a refusal.**
   - `HOLD` (exit 3): nothing was paid. The guard could not decide (SERV unsure or unavailable, an unpaid 404 or 5xx, a variable or unlisted price). Ask the user before doing anything else.
   - exit 1: an error, so nothing was decided. Report it.
4. Raise `--slippage-bps` (allowed drift above the listed price) or `--max-usd` only when the user says so.

## Free checks

`check` instead of `pay` runs every check without paying. `npm --prefix ~/signoff run -s guard -- report` sweeps a 343-endpoint sample of the catalog and reports listing drift, also without paying.

Receipts are written to `~/signoff/.signoff/receipts/`, and payee pins to `~/signoff/.signoff/pins.json`.
