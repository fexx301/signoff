// Audit probe: pay real Kite-catalog endpoints marked "works" through a capped Passport session,
// then check each paid reply against ground truth computed locally (not the listing's own example).
// Usage: PASSPORT_DIR=<dir with prod .kite-passport> tsx scripts/audit-probe.ts [outDir]
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";

const dir = process.env.PASSPORT_DIR!;
const out = process.argv[2] ?? "audit-evidence";
mkdirSync(out, { recursive: true });

type Verdict = { pass: boolean | null; why: string };
type Case = { id: string; listing: string; method: "GET" | "POST"; url: string; query?: Record<string, string>; body?: unknown;
  check: (reply: any) => Promise<Verdict> | Verdict };

const utf8Hex = (s: string) => Buffer.from(s, "utf8").toString("hex");
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const find = (o: any, k: string): any => (o && typeof o === "object" ? (k in o ? o[k] : Object.values(o).map((v) => find(v, k)).find((v) => v !== undefined)) : undefined);
const same = (got: unknown, want: string, why: string): Verdict =>
  ({ pass: String(got ?? "").toLowerCase() === want.toLowerCase(), why: `${why}: expected ${want}, got ${JSON.stringify(got)}` });

const BIG = "123456789abcdef0123456789abcdef"; // listing promises arbitrarily large values
const TEXT = "héllo wörld 😃";

const cases: Case[] = [
  { id: "064eadae0eb4a78c7864f5f3", listing: "agent402 base-convert: any radix 2–36, arbitrarily large", method: "POST", url: "https://agent402.tools/api/base-convert",
    body: { value: BIG, from: 16, to: 10 }, check: (r) => same(find(r, "result"), BigInt("0x" + BIG).toString(10), "hex→dec of 124-bit value") },
  { id: "1ed58e449380d9917a5dde43", listing: "agent402 base64 encode/decode text", method: "POST", url: "https://agent402.tools/api/base64",
    body: { text: TEXT, mode: "encode" }, check: (r) => same(find(r, "result"), b64(TEXT), "UTF-8 base64 of non-ASCII text") },
  { id: "21841eff6f5f1fd43ad1ce03", listing: "quartermaster base64 encode/decode", method: "GET", url: "https://quartermaster.surewhynot.app/v1/base64",
    query: { data: TEXT, op: "encode" }, check: (r) => same(find(r, "result"), b64(TEXT), "UTF-8 base64 of non-ASCII text") },
  { id: "4f6525ec0a9ee43c0c2a704d", listing: "agent402 hex encode/decode text", method: "POST", url: "https://agent402.tools/api/hex",
    body: { text: TEXT, mode: "encode" }, check: (r) => same(find(r, "result"), utf8Hex(TEXT), "UTF-8 hex of non-ASCII text") },
  { id: "15fe9b33456ee3843e045c0d", listing: "sitecheck validate check digits (ISBN…)", method: "GET", url: "https://api.sitecheck-api.workers.dev/api/validate",
    query: { type: "isbn", value: "0306406153" }, check: (r) => ({ pass: find(r, "valid") === false, why: `ISBN-10 with wrong check digit (should be 2): valid=${JSON.stringify(find(r, "valid"))}` }) },
  { id: "73c12709d3f779e1b4b3f816", listing: "vibesprings current Base gas price", method: "GET", url: "https://vibesprings.net/api/price/base-gas",
    check: async (r) => {
      const rpc = await (await fetch("https://mainnet.base.org", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }) })).json();
      const head = Number(BigInt(rpc.result)), got = Number(find(r, "blockNumber"));
      return { pass: Number.isFinite(got) && head - got <= 150, why: `reported block ${got}, Base head ${head} (lag ${head - got} blocks; ≤150 ≈ 5 min = current)` };
    } },
  { id: "7cb78e20859245099db1147e", listing: "quartermaster USD price of a token", method: "GET", url: "https://quartermaster.surewhynot.app/v1/price",
    query: { token: "ETH" }, check: async (r) => {
      // Chainlink ETH/USD on Base, latestRoundData(); answer has 8 decimals.
      const res = await (await fetch("https://mainnet.base.org", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70", data: "0xfeaf968c" }, "latest"] }) })).json();
      const want = Number(BigInt("0x" + res.result.slice(2 + 64, 2 + 128))) / 1e8, got = Number(find(r, "price_usd"));
      return { pass: Math.abs(got - want) / want <= 0.01, why: `price_usd ${got} vs Chainlink ETH/USD on Base ${want} (±1%)` };
    } },
  { id: "22415537bbc2bb3ed4fdc628", listing: "glim fetch clean content of a URL", method: "POST", url: "https://glim.sh/api/v1/web/fetch",
    body: { url: "https://www.rfc-editor.org/rfc/rfc8785.txt", format: "markdown" },
    check: (r) => { const t = JSON.stringify(r); return { pass: t.includes("JSON Canonicalization Scheme"), why: `RFC 8785 page content returned: ${t.includes("JSON Canonicalization Scheme")}` }; } },
  { id: "0c2c9c5e41a069c44bc81418", listing: "sitecheck sentiment POSITIVE/NEGATIVE", method: "GET", url: "https://api.sitecheck-api.workers.dev/api/sentiment",
    query: { text: "Not bad at all. I expected it to break, but it never did." },
    check: (r) => same(find(r, "label"), "POSITIVE", "negated-negative praise") },
  { id: "3cdd6cf17e275763a91c8be4", listing: "quartermaster translate into a named language", method: "GET", url: "https://quartermaster.surewhynot.app/v1/translate",
    query: { text: "The bank by the river is closed on Sunday.", to: "French" },
    check: (r) => { const t = String(find(r, "translation") ?? ""); const ok = /rive|fleuve|rivière/i.test(t) && /dimanche/i.test(t) && /ferm/i.test(t);
      return { pass: ok, why: `needs river-bank sense + Sunday + closed: ${JSON.stringify(t)}` }; } },
];

const MATH = "What is 4817 * 293? Reply with only the number.";
const mathOk = (r: any, model?: string): Verdict => {
  const t = String(r?.choices?.[0]?.message?.content ?? "").trim();
  const ok = t.replace(/[,\s.]/g, "") === "1411381" && (!model || String(r?.model ?? "").includes(model));
  return { pass: ok, why: `want "1411381"${model ? ` from ${model}` : ""}; got ${JSON.stringify(t.slice(0, 80))} model=${JSON.stringify(r?.model)}` };
};
const has = (r: any, re: RegExp, what: string): Verdict => ({ pass: re.test(JSON.stringify(r ?? "")), why: `${what}: ${re.test(JSON.stringify(r ?? ""))}` });
const RFC = "https://www.rfc-editor.org/rfc/rfc8785.html";
const round2: Case[] = [
  { id: "0927ada442ab966d4cd7cb02", listing: "blockrun LLM chat (model as requested)", method: "POST", url: "https://blockrun.ai/api/v1/chat/completions",
    body: { model: "openai/gpt-4.1-mini", messages: [{ role: "user", content: MATH }] }, check: (r) => mathOk(r, "gpt-4.1-mini") },
  { id: "1f56d49d1a28d6c45d738996", listing: "gedx402 LLM chat", method: "POST", url: "https://chat.gedx402.com/v1/chat/completions",
    body: { messages: [{ role: "user", content: MATH }] }, check: (r) => mathOk(r) },
  { id: "6bc310811df41a2bdd25a9ca", listing: "aispace Venice chat (model as requested)", method: "POST", url: "https://x402.aispace.bot/api/v1/chat/completions",
    body: { model: "gemini-3-6-flash", messages: [{ role: "user", content: MATH }] }, check: (r) => mathOk(r, "gemini-3-6-flash") },
  { id: "7b4319aa404c88d8a93f687a", listing: "oblique bounded chat", method: "POST", url: "https://api.oblique.markets/api/v1/paid/chat-completion",
    body: { messages: [{ role: "user", content: MATH }], max_tokens: 50 }, check: (r) => mathOk(r) },
  { id: "392f01889058d55607265fc8", listing: "aispace web search", method: "POST", url: "https://x402.aispace.bot/api/v1/augment/search",
    body: { query: "JSON Canonicalization Scheme RFC" }, check: (r) => has(r, /rfc8785/i, "results include RFC 8785") },
  { id: "731113e100f8f2601dfc0541", listing: "cyberwarex web search", method: "GET", url: "https://search.cyberwarex.com/search",
    query: { q: "JSON Canonicalization Scheme RFC" }, check: (r) => has(r, /rfc8785/i, "results include RFC 8785") },
  { id: "0b41e8e5749d54acd37bf3f4", listing: "x402-data-api page → Markdown", method: "GET", url: "https://x402-data-api.onrender.com/api/scrape",
    query: { url: RFC }, check: (r) => has(r, /JSON Canonicalization Scheme/, "RFC 8785 content") },
  { id: "5867188674d3b00b9269613f", listing: "parallel extract URL content", method: "POST", url: "https://parallelmpp.dev/api/extract",
    body: { urls: [RFC] }, check: (r) => has(r, /Canonicalization/, "RFC 8785 content") },
  { id: "47323476dfbda0b2572792f8", listing: "toolsmith YouTube transcript", method: "GET", url: "https://toolsmith-api.dassad10.workers.dev/t/youtube/transcript",
    query: { v: "kJQP7kiw5Fk" }, check: (r) => has(r, /despacito/i, "Despacito transcript contains 'despacito'") },
  { id: "5151c49e000bb7c39e4573fa", listing: "schemasure schema-valid extraction", method: "POST", url: "https://schemasure.com/v2/extract",
    body: { inputType: "text", input: "Invoice INV-2049 issued by Northwind Traders GmbH on 3 November 2026. Amount due: €1.250,50 (EUR), payable by 1 December 2026.",
      schema: { type: "object", properties: { invoiceId: { type: "string" }, vendor: { type: "string" }, total: { type: "number" }, currency: { type: "string" }, dueDate: { type: "string", format: "date" } },
        required: ["invoiceId", "vendor", "total", "currency", "dueDate"] } },
    check: (r) => { const d = r?.data ?? {}; const ok = d.invoiceId === "INV-2049" && /Northwind/.test(d.vendor ?? "") && d.total === 1250.5 && d.currency === "EUR" && d.dueDate === "2026-12-01";
      return { pass: ok, why: `want INV-2049/Northwind/1250.5/EUR/2026-12-01; got ${JSON.stringify(d)}` }; } },
];
if (process.env.ROUND === "2") cases.splice(0, cases.length, ...round2);

const results = [];
const skip = new Set((process.env.SKIP ?? "").split(",").filter(Boolean));
for (const c of cases.filter((c) => !skip.has(c.id))) {
  const url = c.query ? `${c.url}?${new URLSearchParams(c.query)}` : c.url;
  const args = ["session", "execute", "--url", url, "--method", c.method, "--idempotency-key", `audit-${c.id}-${randomUUID()}`, "--output", "json", "--no-interactive", "--no-browser"];
  if (c.body !== undefined) args.push("--body", JSON.stringify(c.body), "--headers", JSON.stringify({ "content-type": "application/json" }));
  let raw = "", parsed: any = null, verdict: Verdict;
  try {
    raw = execFileSync("kpass", args, { cwd: dir, env: { ...process.env, KITE_PASSPORT_BASE_URL: "https://passport.prod.gokite.ai" }, timeout: 120_000 }).toString();
  } catch (e: any) { raw = String(e.stdout ?? "") + String(e.stderr ?? ""); }
  try { parsed = JSON.parse(raw); } catch {}
  const body = parsed ? (parsed.x402?.parsed_response_body ?? parsed.x402?.response_body ?? null) : null;
  let reply: any = body;
  if (typeof body === "string") { try { reply = JSON.parse(body); } catch {} }
  try { verdict = parsed ? await c.check(reply) : { pass: null, why: "no parseable kpass output (not paid or failed)" }; }
  catch (e: any) { verdict = { pass: null, why: `checker error: ${e.message}` }; }
  const rec = { id: c.id, listing: c.listing, request: { method: c.method, url, body: c.body ?? null },
    paid: parsed?.payment ? { tx: parsed.payment.transaction_hash, amount: parsed.payment.amount, network: parsed.payment.network, http: parsed.payment.status_code } : null, verdict,
    replySha256: "sha256:" + createHash("sha256").update(raw).digest("hex") };
  writeFileSync(`${out}/${c.id}.raw.json`, raw);
  results.push(rec);
  console.log(`${verdict.pass === true ? "PASS" : verdict.pass === false ? "FAIL" : "N/A "}  ${c.listing}\n      ${verdict.why}`);
}
writeFileSync(`${out}/results.json`, JSON.stringify(results, null, 1));
