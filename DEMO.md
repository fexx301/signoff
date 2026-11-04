# Demo script: Signoff (target 2:30, max 3:00)

**Setup before recording:**
- A terminal at about 18pt font, plus a browser tab open on Basescan.
- A Passport session approved for $0.02 per call and $0.10 total.
- `PASSPORT_DIR` exported.
- A fresh `.signoff/` folder, so the first paid call shows the payee being pinned.

**Labels:** every number on screen comes from a live run. Say "live" when it is live, and "recorded on Nov 3" for the earlier silent charge.

---

## 0:00–0:20 Hook

**Screen:** Kite catalog line for sitecheck `/api/validate`: "works · $0.001".

> "Kite's catalog says this endpoint costs a tenth of a cent. Yesterday my agent paid it through Passport. It was charged twice that, and nothing warned me."

**Screen:** Basescan, tx `0x45ea39ec…21fb`, a 0.002 USDC transfer.

> "Passport caps how much an agent spends. Nothing checks what it's actually paying for."

## 0:20–0:50 The finding

**Run:** `npm run guard -- report` (about 50 s; cut to the result).

> "Signoff checks Kite's catalog for free. It sends each endpoint an unpaid request and reads the price it would really charge."

Highlight these lines from the output:
- "24 of 165 marked works ask more than listed"
- "tenna: 10×"
- "stablestudio: $10 against a listed $0.022"

> "A day apart, same result. The listing and the live price drift, and the catalog doesn't record who should get paid."

## 0:50–1:15 The refusal

**Run:** `npm run guard -- pay 15fe9b33456ee3843e045c0d`

**Screen:** `REFUSE price_drift: asks $0.002 vs listed $0.001 (2.00x)`. No transaction follows.

> "Same endpoint, same request. This time Signoff checks before Passport signs. It refuses, and no money moves."

## 1:15–1:50 The intent check (SERV)

**Run:**
```
npm run guard -- check 3d9694810dd754fd758e3ed9 \
  --intent "What's the weather in Lagos this week?" --slippage-bps 10000
```

**Screen:** `REFUSE off_intent … (quote: "lat=52.52&lon=13.405")`

> "Price isn't the only risk. My agent picked a weather endpoint, but the request points at Berlin. SERV Reasoning reads the exact request against what I asked for and quotes the line that's wrong. If SERV can't quote evidence, Signoff holds the payment instead of guessing."

Optional, if there's time: the `to:2` base-convert refusal.

## 1:50–2:25 The clean path

**Run:**
```
npm run guard -- pay 064eadae0eb4a78c7864f5f3 \
  --body '{"value":"ff","from":16,"to":10}' --intent "Convert the hex value ff to decimal"
```

**Screen:**
- `ALLOW`
- `payee_unpinned → pinned`
- `paid $0.001 on Base, tx …`
- `reply check (SERV): yes — 255`

Open the transaction on Basescan, then the receipt JSON.

> "When everything matches, it pays through my Passport session, pins the payee so a change later gets refused, and SERV checks that the reply actually answers me. The receipt binds the listing, the live terms, the verdicts and the transaction."

## 2:25–2:50 Close

**Screen:** the README decision table.

> "Kite Passport sets the limits. Signoff checks the signature. Kite gets a free, rerunnable health check of its catalog; agent builders get a guard they can drop in front of `kpass`. Next: Passport accepting a pinned amount and payee, so the check and the payment can't drift apart."

---

**Before submitting:**
- [ ] Recheck that the sitecheck drift still exists on the recording day. If it has been fixed, say so and use tenna instead.
- [ ] Captions on.
- [ ] Mark Nov 3 footage as "recorded".
- [ ] The payee-change refusal is shown only as a table row and unit test; no live payee change was observed.
