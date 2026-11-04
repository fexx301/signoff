# Evidence

Every file here was written by the guard during real runs on 2026-11-04, against Kite's live catalog. Paid transactions are on Base mainnet and can be checked on Basescan.

## Drift reports (free, nothing paid)

- `drift-report-2026-11-04.json` (07:44 UTC) and `drift-report-2026-11-04-0817.json` (08:17 UTC, the run shown in the demo video). Each is a 343-endpoint keyword sample; both found 24 of 165 `works` endpoints asking more than their listed price.

## Receipts

| Receipt (UTC time) | Endpoint | Decision | Why | Paid |
|---|---|---|---|---|
| 07:15:02 | sitecheck `/api/validate` | REFUSE | price_drift (2×) | no |
| 07:15:04 | tenna `/lumi/social_timing_check` | REFUSE | price_drift (10×), over_budget | no |
| 07:15:06 | ottoai `/generate-meme` | REFUSE | retired (410) | no |
| 07:15:53 | agent402 `/api/base-convert` | ALLOW | price and payee match; payee pinned on first use | [`0x2796c0ea…4055`](https://basescan.org/tx/0x2796c0ea32567471b97b83f3900e2e16a854c9e0af1fe95f8a5f763232724055) |
| 07:15:54 | sitecheck `/api/validate` | REFUSE | price_drift (2×), refused before paying | no |
| 07:42:07 | agent402 `/api/base-convert` | ALLOW | SERV: request fits "convert hex ff to decimal" | check only |
| 07:42:10 | agent402 `/api/base-convert` with `to:2` | REFUSE | off_intent; SERV quotes `"to":2` | no |
| 07:42:13 | quartermaster `/v1/translate` | REFUSE | off_intent; wrong job for a sentiment intent | no |
| 07:42:16 | sitecheck `/api/weather` | REFUSE | off_intent; Berlin coordinates for a Lagos intent | no |
| 07:42:38 | agent402 `/api/base-convert` | ALLOW | SERV reply check: yes ("255") | [`0x210b1a2f…f2b7`](https://basescan.org/tx/0x210b1a2f23e6f9859685d9d7018f22f425c327fbabfb270283b7a8308de4f2b7) |
| 08:16:21 | sitecheck `/api/validate` | REFUSE | price_drift (shown in the video) | no |
| 08:16:25 | sitecheck `/api/weather` | REFUSE | off_intent; SERV quotes `lat=52.52` (shown in the video) | no |
| 08:16:34 | agent402 `/api/base-convert` | ALLOW | SERV reply check: yes (shown in the video) | [`0x4889b7f1…a4f0`](https://basescan.org/tx/0x4889b7f1cc42febbcc67430fa93b7e50918ceece612c435768b62fbe4e28a4f0) |
| 16:48:43 **SIMULATED-PIN** | agent402 `/api/base-convert` | REFUSE | payee_changed | no |

**About the SIMULATED-PIN receipt.** No real payee change was observed. To show the refusal live, the pinned payee in `.signoff/pins.json` was edited by hand to `0x1111…1111`, then a real check was run. The live 402 still named the real payee (`0xabf4…a9d0`), so the guard refused. The pin was restored afterwards.

## Before the guard

Plain Passport paid two sitecheck endpoints 2× their listed $0.001 on 2026-11-03, with no warning: [`0x45ea39ec…21fb`](https://basescan.org/tx/0x45ea39ec465d54a627fd86df1317c971a5d69cc034e01d9a981ca2eb919321fb) and [`0xa19a865d…35a8`](https://basescan.org/tx/0xa19a865dff80bccb65f12747c1b7a4718c5944b6b8b20925c0604cb5729835a8). Those runs used the research script `scripts/audit-probe.ts`, not the guard.
