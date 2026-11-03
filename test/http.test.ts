import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import { once } from "node:events";
const fixtures = vi.hoisted(() => ({ payment: null as unknown, settle: vi.fn(), prepare: vi.fn(), confirm: vi.fn() }));
vi.mock("../src/config.js", async () => {
  const { KITE_TESTNET } = await import("../src/kite.js");
  return { config: { port: 8080, publicBaseUrl: "http://localhost", dbPath: ":memory:", chain: KITE_TESTNET, facilitatorUrl: "http://invalid", payTo: "0x1111111111111111111111111111111111111111", processorAccount: null, processorPrivateKey: "", sellerPayoutAddress: "0x2222222222222222222222222222222222222222", sellerSecret: "fixture-secret", jobPriceUsd: 0.05, feeBps: 200, servApiKey: "", servBaseUrl: "http://invalid", servModel: "fixture", dolphinApiKey: "", reppoApiKey: "", reppoMinSettlementMinutes: 10, devSkipPayment: true, devMockVerdict: true, devMockPayout: true, autoDeliver: true } };
});
vi.mock("../src/x402.js", async original => {
  const actual = await original<typeof import("../src/x402.js")>();
  return { ...actual, buildX402: () => ({}), x402Gate: () => (_req: unknown, res: { locals: Record<string, unknown> }, next: () => void) => { res.locals.x402 = fixtures.payment; next(); }, settleVerifiedPayment: fixtures.settle };
});
vi.mock("../src/payout.js", async original => {
  const actual = await original<typeof import("../src/payout.js")>();
  return { ...actual, prepareTransfer: fixtures.prepare, confirmTransfer: fixtures.confirm };
});
import { config } from "../src/config.js";
import { createApp } from "../src/server.js";
import { store } from "../src/store.js";
import { toAtomic } from "../src/kite.js";
let server: Server;
let base: string;
const body = { title: "HTTP fixture", question: "Explain bounded tasks", audience: "Builders", criteria: { requiredSections: ["Summary"], minWords: 20, minCitations: 0, mustMention: [], forbiddenPhrases: [] } };
function verifiedPayment(id: string) { return { paymentPayload: { fixtureId: id }, paymentRequirements: { network: config.chain.network, asset: config.chain.assetAddress, amount: toAtomic(0.05, 18).toString() } }; }
async function post(data: unknown) { return fetch(`${base}/v1/jobs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) }); }
beforeAll(async () => {
  server = createApp().listen(0, "127.0.0.1"); await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); store.close(); });
beforeEach(() => {
  fixtures.payment = null; fixtures.settle.mockReset(); fixtures.prepare.mockReset(); fixtures.confirm.mockReset();
  config.devSkipPayment = true; config.devMockVerdict = true; config.devMockPayout = true;
  fixtures.prepare.mockImplementation(async job => ({ kind: job.disposition, to: job.spec.sellerPayout, amountAtomic: job.priceAtomic, hash: `mock_${job.id}`, rawTransaction: "private-fixture-data", mock: true }));
  fixtures.confirm.mockResolvedValue(undefined);
});
it("runs the development HTTP workflow and labels the receipt as simulated", async () => {
  const response = await post(body); expect(response.status).toBe(201);
  const created = await response.json() as { id: string };
  let current = await (await fetch(`${base}/v1/jobs/${created.id}`)).json() as { status: string; transfer: Record<string, unknown> };
  for (let i = 0; i < 20 && current.status !== "released"; i++) current = await (await fetch(`${base}/v1/jobs/${created.id}`)).json() as typeof current;
  expect(current.status).toBe("released"); expect(current.transfer).not.toHaveProperty("rawTransaction");
  const html = await (await fetch(`${base}/receipt/${created.id}`)).text();
  expect(html).toContain("SIMULATED RUN"); expect(html).not.toContain("private-fixture-data");
});
it("requires seller authentication for delivery and retries", async () => {
  for (const action of ["deliver", "retry", "appeal", "poll-appeal"]) {
    const response = await fetch(`${base}/v1/jobs/unknown/${action}`, { method: "POST" });
    expect(response.status).toBe(401);
  }
});
it("cannot deliver a job after incoming settlement fails", async () => {
  config.devSkipPayment = false; config.devMockVerdict = false; config.devMockPayout = false;
  fixtures.payment = verifiedPayment("failed"); fixtures.settle.mockResolvedValue({ ok: false, error: "fixture-failure" });
  const response = await post(body); expect(response.status).toBe(402);
  const data = await response.json() as { jobId: string };
  const delivered = await fetch(`${base}/v1/jobs/${data.jobId}/deliver`, { method: "POST", headers: { "content-type": "application/json", "x-signoff-key": "fixture-secret" }, body: JSON.stringify({ content: "## Summary\n" + "content ".repeat(30) }) });
  expect(delivered.status).toBe(409); expect(fixtures.prepare).not.toHaveBeenCalled();
  expect(store.get(data.jobId)?.status).toBe("payment_pending");
});
it("binds a signed payment to one job and rejects a changed spec", async () => {
  config.autoDeliver = false; config.devSkipPayment = false; config.devMockVerdict = false; config.devMockPayout = false;
  fixtures.payment = verifiedPayment("replay");
  fixtures.settle.mockResolvedValue({ ok: true, transaction: "0x" + "a".repeat(64), payer: "0x3333333333333333333333333333333333333333", headers: {} });
  const first = await (await post(body)).json() as { id: string };
  const secondResponse = await post(body); const second = await secondResponse.json() as { id: string };
  expect(secondResponse.status).toBe(200); expect(second.id).toBe(first.id); expect(fixtures.settle).toHaveBeenCalledTimes(1);
  const conflict = await post({ ...body, question: "Different work" }); expect(conflict.status).toBe(409);
  expect(fixtures.settle).toHaveBeenCalledTimes(1);
});
