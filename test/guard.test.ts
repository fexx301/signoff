import { expect, it } from "vitest";
import { BASE, BASE_USDC, decide, decodeChallenge, validateFit, type Listing, type Live } from "../src/guard.js";

const listing: Listing = { id: "x", scope: "GET a.example /p", method: "GET", url: "https://a.example/p", priceUsd: 0.001, state: "works", example: {} };
const payee = "0x1111111111111111111111111111111111111111";
const offer = (amountUsd: number, payTo = payee, scheme = "exact") => ({ network: BASE, asset: BASE_USDC, scheme, amountUsd, payTo });
const live = (o: ReturnType<typeof offer> | null, http = 402, otherOffers = 1): Live => ({ http, offer: o, otherOffers });
const policy = { maxUsd: 0.02, slippageBps: 0 };
const pin = { payTo: payee, firstSeen: "2026-11-04T00:00:00Z" };

it("allows a listed price to the pinned payee", () => {
  expect(decide(listing, live(offer(0.001)), pin, policy)).toMatchObject({ decision: "ALLOW", reasons: [] });
});
it("refuses a 2x drift that the session cap would have paid silently", () => {
  const d = decide(listing, live(offer(0.002)), pin, policy);
  expect(d.decision).toBe("REFUSE");
  expect(d.reasons.map((r) => r.code)).toEqual(["price_drift"]);
});
it("allows drift inside the slippage tolerance", () => {
  expect(decide(listing, live(offer(0.002)), pin, { ...policy, slippageBps: 10_000 }).decision).toBe("ALLOW");
});
it("refuses a changed payee and reports every reason", () => {
  const d = decide(listing, live(offer(0.05, "0x2222222222222222222222222222222222222222")), pin, policy);
  expect(d.reasons.map((r) => r.code)).toEqual(["price_drift", "over_budget", "payee_changed"]);
});
it("notes a first-use payee instead of refusing it", () => {
  const d = decide(listing, live(offer(0.001)), undefined, policy);
  expect(d.decision).toBe("ALLOW");
  expect(d.notes.map((n) => n.code)).toContain("payee_unpinned");
});
it("refuses retired endpoints but only holds an ambiguous unpaid 404", () => {
  expect(decide(listing, live(null, 410), pin, policy).decision).toBe("REFUSE");
  expect(decide(listing, live(null, 404), pin, policy)).toMatchObject({ decision: "HOLD", reasons: [{ code: "http_404" }] });
});
it("refuses a request with no USDC-on-Base option and holds an unreadable one", () => {
  expect(decide(listing, live(null, 402, 2), pin, policy).reasons[0]!.code).toBe("wrong_asset");
  expect(decide(listing, live(null, 402, 0), pin, policy).reasons[0]!.code).toBe("unparsed_terms");
});
it("holds a variable-price scheme and an unlisted price", () => {
  expect(decide(listing, live(offer(0.001, payee, "upto")), pin, policy).reasons[0]!.code).toBe("variable_price");
  expect(decide({ ...listing, priceUsd: null }, live(offer(0.001)), pin, policy).reasons[0]!.code).toBe("unlisted_price");
});
it("decodes the Base USDC offer from a PAYMENT-REQUIRED header", () => {
  const ch = { x402Version: 2, accepts: [
    { scheme: "exact", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", amount: "2000", asset: "EPj", payTo: "S" },
    { scheme: "exact", network: BASE, amount: "2000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: "0xABC" },
  ] };
  const { offer: o, offers } = decodeChallenge(Buffer.from(JSON.stringify(ch)).toString("base64"), "");
  expect(offers).toBe(2);
  expect(o).toEqual({ network: BASE, asset: BASE_USDC, scheme: "exact", amountUsd: 0.002, payTo: "0xabc" });
});
it("falls back to a v1 JSON body with maxAmountRequired", () => {
  const body = JSON.stringify({ accepts: [{ scheme: "exact", network: BASE, maxAmountRequired: "100000", asset: BASE_USDC, payTo: "0xdef" }] });
  expect(decodeChallenge(null, body).offer?.amountUsd).toBe(0.1);
});

it("refuses an off-intent request and holds an unclear one", () => {
  const no = { verdict: "no" as const, reason: "translates, user asked for sentiment", evidence: "translate" };
  expect(decide(listing, live(offer(0.001)), pin, policy, no).reasons.map((r) => r.code)).toEqual(["off_intent"]);
  expect(decide(listing, live(offer(0.001)), pin, policy, { verdict: "unsure", reason: "no SERV", evidence: "" }).decision).toBe("HOLD");
});
it("downgrades a SERV verdict without a verbatim quote to unsure", () => {
  expect(validateFit({ verdict: "no", reason: "r", evidence: "not in subject" }, "endpoint: weather").verdict).toBe("unsure");
  expect(validateFit({ verdict: "yes", reason: "r", evidence: "weather" }, "endpoint: weather").verdict).toBe("yes");
  expect(() => validateFit({ verdict: "maybe" }, "x")).toThrow();
});
