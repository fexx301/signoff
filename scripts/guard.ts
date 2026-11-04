// signoff guard CLI. --intent "<what the user asked for>" adds the SERV fit check (before paying, and on the reply).
//   tsx scripts/guard.ts check <catalogId> [--query JSON] [--body JSON] [--max-usd 0.02] [--slippage-bps 0]
//   tsx scripts/guard.ts report [--words a,b,c]   (free catalog-wide drift report)
//   tsx scripts/guard.ts pay   <catalogId> ... (PASSPORT_DIR = folder holding the Passport login/session; default: current folder)
// Exit: 0 allowed/paid, 2 refused, 3 held, 1 error.
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { catalogIds, decide, loadListing, report, type ReportRow, pay, probe, readPins, requestSubject, servFit, writePin, writeReceipt, type Input } from "../src/guard.js";

// The same 40 search words used for the Nov 3 sample.
const DEFAULT_WORDS = "get,create,search,generate,list,check,image,text,video,audio,email,web,data,token,price,weather,research,translate,upload,place,phone,domain,crypto,wallet,social,chat,model,speech,vision,memes,trends,enrich,news,company,url,page,file,report,status";
const { positionals, values } = parseArgs({ allowPositionals: true, options: {
  query: { type: "string" }, body: { type: "string" }, intent: { type: "string" }, words: { type: "string" }, "max-usd": { type: "string", default: "0.02" },
  "slippage-bps": { type: "string", default: "0" }, state: { type: "string", default: ".signoff" },
} });
const [cmd, id] = positionals;
if (cmd === "report") {
  const words = (values.words ?? DEFAULT_WORDS).split(",").map((w) => w.trim()).filter(Boolean);
  const ids = await catalogIds(words);
  const rows = await report(ids, { maxUsd: Number(values["max-usd"]), slippageBps: Number(values["slippage-bps"]) });
  const tally = (pred: (r: ReportRow) => boolean) => rows.filter(pred).length;
  const works = rows.filter((r) => r.catalogState === "works" && r.decision);
  const code = (r: ReportRow, c: string) => !!r.decision?.reasons.some((x) => x.code === c);
  console.log(`${rows.length} endpoints from ${words.length} search words; ${tally((r) => !!r.decision)} checked, ${tally((r) => !!r.error)} skipped`);
  console.log(`marked "works" and checked: ${works.length}`);
  for (const c of ["price_drift", "retired", "wrong_asset", "variable_price", "unparsed_terms"]) console.log(`  ${c}: ${works.filter((r) => code(r, c)).length}`);
  console.log(`  cheaper_than_listed: ${works.filter((r) => r.decision!.notes.some((n) => n.code === "cheaper_than_listed")).length}`);
  console.log(`  unpaid non-402 (held, not proof of death): ${works.filter((r) => r.decision!.reasons.some((x) => x.code.startsWith("http_"))).length}`);
  const worst = rows.filter((r) => code(r, "price_drift")).sort((a, b) => b.live!.offer!.amountUsd / b.listedUsd! - a.live!.offer!.amountUsd / a.listedUsd!).slice(0, 8);
  for (const r of worst) console.log(`  ${(r.live!.offer!.amountUsd / r.listedUsd!).toFixed(1)}x  ${r.scope}  listed $${r.listedUsd} asks $${r.live!.offer!.amountUsd}  [${r.catalogState}]`);
  mkdirSync(values.state!, { recursive: true });
  const path = `${values.state}/report-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(path, JSON.stringify({ at: new Date().toISOString(), words, policy: { maxUsd: Number(values["max-usd"]), slippageBps: Number(values["slippage-bps"]) }, rows }, null, 1));
  console.log(`report: ${path}`);
  process.exit(0);
}
if (!["check", "pay"].includes(cmd ?? "") || !id) { console.error("usage: guard.ts check|pay <catalogId> [--query JSON] [--body JSON] [--max-usd N] [--slippage-bps N]"); process.exit(1); }

const listing = await loadListing(id);
const input: Input = {
  query: values.query ? JSON.parse(values.query) : listing.example.query,
  body: values.body ? JSON.parse(values.body) : listing.example.body,
};
const intent = values.intent;
const [live, fit] = await Promise.all([probe(listing, input), intent ? servFit(intent, "request", requestSubject(listing, input)) : undefined]);
const decision = decide(listing, live, readPins(values.state!)[listing.scope], { maxUsd: Number(values["max-usd"]), slippageBps: Number(values["slippage-bps"]) }, fit);

console.log(`${decision.decision}  ${listing.scope}  (catalog: ${listing.state}, listed $${listing.priceUsd ?? "?"}; live ${live.http ?? "no response"}${live.offer ? `, asks $${live.offer.amountUsd} → ${live.offer.payTo}` : ""})`);
for (const r of [...decision.reasons, ...decision.notes]) console.log(`  - ${r.code}: ${r.detail}`);

let paid, replyFit;
if (cmd === "pay" && decision.decision === "ALLOW") {
  // kpass resolves its login and current session from the folder it runs in.
  const dir = process.env.PASSPORT_DIR || process.cwd();
  paid = pay(listing, input, dir, `signoff-${listing.id}-${randomUUID()}`);
  if (paid.ok && live.offer) writePin(values.state!, listing.scope, live.offer.payTo);
  console.log(paid.ok ? `  paid $${paid.amountUsd} on Base, tx ${paid.tx}, reply HTTP ${paid.http}` : `  payment failed: ${paid.raw.slice(0, 300)}`);
  if (paid.ok && intent) {
    replyFit = await servFit(intent, "reply", JSON.stringify(paid.reply).slice(0, 12_000));
    console.log(`  reply check (SERV): ${replyFit.verdict} — ${replyFit.reason}`);
  }
}
console.log(`  receipt: ${writeReceipt(values.state!, { listing, input, live, decision, paid, intent, fit, replyFit })}`);
process.exit(paid && !paid.ok ? 1 : { ALLOW: 0, REFUSE: 2, HOLD: 3 }[decision.decision]);
