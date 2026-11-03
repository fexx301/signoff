import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../src/config.js", async () => {
  const { KITE_TESTNET } = await import("../src/kite.js");
  return {
    config: {
      port: 8080, publicBaseUrl: "http://localhost:8080", dbPath: ":memory:",
      chain: KITE_TESTNET, facilitatorUrl: "http://invalid", payTo: "0x1111111111111111111111111111111111111111",
      processorAccount: null, processorPrivateKey: "", sellerPayoutAddress: "0x2222222222222222222222222222222222222222",
      sellerSecret: "test-only-secret", jobPriceUsd: 0.05, feeBps: 200,
      servApiKey: "", servBaseUrl: "http://invalid", servModel: "fixture",
      dolphinApiKey: "", dolphinBaseUrl: "http://invalid", dolphinModel: "fixture",
      reppoApiKey: "", reppoBaseUrl: "http://invalid", reppoMinSettlementMinutes: 10,
      devSkipPayment: true, devMockVerdict: true, devMockPayout: true, autoDeliver: false,
    },
  };
});
vi.mock("../src/payout.js", async (original) => {
  const actual = await original<typeof import("../src/payout.js")>();
  return { ...actual, prepareTransfer: vi.fn(actual.prepareTransfer), confirmTransfer: vi.fn(actual.confirmTransfer) };
});
vi.mock("../src/serv.js", async (original) => {
  const actual = await original<typeof import("../src/serv.js")>();
  return { ...actual, evaluateArtifact: vi.fn(actual.evaluateArtifact) };
});
vi.mock("../src/reppo.js", async (original) => {
  const actual = await original<typeof import("../src/reppo.js")>();
  return { ...actual, pollAppeal: vi.fn(), submitAppeal: vi.fn() };
});
vi.mock("../src/dolphin.js", () => ({ generateArtifact: vi.fn() }));

import { config } from "../src/config.js";
import { store } from "../src/store.js";
import { JobStore } from "../src/db.js";
import * as jobs from "../src/jobs.js";
import * as payout from "../src/payout.js";
import * as serv from "../src/serv.js";
import * as reppo from "../src/reppo.js";
import { generateArtifact } from "../src/dolphin.js";
import { combineVerdict, deterministicChecks } from "../src/acceptance.js";
import { SEMANTIC_IDS } from "../src/policy.js";
import type { Artifact, Job, ServVerdict } from "../src/types.js";

const liveFetch = vi.fn();
const content = "## Summary\n" + "A bounded task has a measurable outcome and a clear scope. ".repeat(5);
const artifact: Artifact = { content, model: "fixture", provider: "mock", generatedAt: new Date().toISOString(), variant: "good" };
function fundedLiveFixture(): Job { return jobs.createJob(input, 0.05); }
const input = { title: "Fixture", question: "Explain bounded tasks", audience: "Builders", criteria: { requiredSections: ["Summary"], minWords: 20, minCitations: 0, mustMention: [], forbiddenPhrases: [] } };
function funded(): Job {
  const job = jobs.createJob(input, 0.05);
  return jobs.attachPayment(job.id, { network: config.chain.network, asset: config.chain.assetAddress, amountAtomic: job.priceAtomic, payer: "0x3333333333333333333333333333333333333333", tx: null, mode: "dev" });
}
function reviewing(): Job {
  const job = funded();
  job.artifact = artifact;
  job.status = "needs_review";
  job.verdict = { decision: "hold", reason: "uncertain", deterministic: [], serv: null, threshold: 0.6 };
  store.save(job);
  return job;
}
function appealed(): Job {
  const job = reviewing();
  job.status = "appealed";
  job.appealDeadline = new Date(Date.now() + 60_000).toISOString();
  job.appeal = { evalId: "fixture", status: "PENDING", submittedAt: new Date().toISOString(), reason: "review", score: null, decision: null, critique: null };
  store.save(job);
  return job;
}
function rawVerdict() {
  return { decision: "pass", confidence: 0.95, summary: "Fixture", criteria: SEMANTIC_IDS.map(id => ({ id, criterion: id, passed: true, evidence: "bounded task" })) };
}

beforeEach(async () => {
  config.devSkipPayment = true; config.devMockVerdict = true; config.devMockPayout = true;
  config.servApiKey = "";
  const realServ = await vi.importActual<typeof import("../src/serv.js")>("../src/serv.js");
  const realPayout = await vi.importActual<typeof import("../src/payout.js")>("../src/payout.js");
  vi.mocked(serv.evaluateArtifact).mockReset().mockImplementation(realServ.evaluateArtifact);
  vi.mocked(payout.prepareTransfer).mockReset().mockImplementation(realPayout.prepareTransfer);
  vi.mocked(payout.confirmTransfer).mockReset().mockImplementation(realPayout.confirmTransfer);
  vi.mocked(generateArtifact).mockReset().mockResolvedValue(artifact);
  vi.mocked(reppo.pollAppeal).mockReset(); vi.mocked(reppo.submitAppeal).mockReset();
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Network is forbidden in regression tests"); }));
});
afterAll(() => { store.close(); vi.unstubAllGlobals(); });

describe("funding and verifier boundaries", () => {
  it("does not deliver or pay an unpaid settlement failure", async () => {
    const job = jobs.createJob(input, 0.05);
    jobs.failJob(job.id, "Settlement failed");
    await expect(jobs.deliverArtifact(job.id, artifact)).rejects.toThrow("settled payment");
    await expect(jobs.releaseJob(job.id)).rejects.toThrow("settled payment");
    expect(payout.prepareTransfer).not.toHaveBeenCalled();
  });
  it("rejects a mismatched payment and second payment attachment", () => {
    const job = funded();
    expect(() => jobs.attachPayment(job.id, job.payment!)).toThrow();
    const unpaid = jobs.createJob(input, 0.05);
    expect(() => jobs.attachPayment(unpaid.id, { ...job.payment!, amountAtomic: "1" })).toThrow();
  });
  it("does not mock approval when the SERV key is absent", async () => {
    const job = funded();
    job.payment!.mode = "x402"; job.payment!.tx = "0x" + "a".repeat(64); store.save(job);
    config.devSkipPayment = false; config.devMockVerdict = false; config.devMockPayout = false;
    const result = await jobs.deliverArtifact(job.id, { ...artifact, provider: "serv" });
    expect(result.status).toBe("needs_review");
    expect(result.error).toContain("SERV_API_KEY");
    expect(payout.prepareTransfer).not.toHaveBeenCalled();
  });
  it("blocks simulated work from driving a live transfer", async () => {
    const job = funded(); config.devMockPayout = false;
    await expect(jobs.deliverArtifact(job.id, artifact)).rejects.toThrow("Simulated");
    expect(payout.prepareTransfer).not.toHaveBeenCalled();
  });
  it("holds a low-confidence verdict instead of refunding", async () => {
    const job = funded();
    const verdict = serv.validateVerdict(rawVerdict(), content, "fixture"); verdict.confidence = 0.2;
    vi.mocked(serv.evaluateArtifact).mockResolvedValue(verdict);
    const result = await jobs.deliverArtifact(job.id, artifact);
    expect(result.status).toBe("needs_review"); expect(result.verdict?.decision).toBe("hold");
    expect(payout.prepareTransfer).not.toHaveBeenCalled();
  });
  it("releases accepted work and refunds deterministic rejection", async () => {
    const good = await jobs.deliverArtifact(funded().id, artifact);
    expect(good.status).toBe("released"); expect(good.receipt?.payout?.tx).toBe(good.payoutTx);
    const bad = await jobs.deliverArtifact(funded().id, { ...artifact, content: "Too short" });
    expect(bad.status).toBe("refunded"); expect(bad.receipt?.refund?.tx).toBe(bad.refundTx);
  });
  it("does not let the buyer redirect the configured seller payout", () => {
    expect(() => jobs.createJob({ ...input, sellerPayout: "0x4444444444444444444444444444444444444444" }, 0.05)).toThrow("configured seller");
  });
});

describe("single disposition and recovery", () => {
  it("persists the signed intent before awaiting confirmation", async () => {
    vi.mocked(payout.confirmTransfer).mockImplementation(async intent => {
      const stored = store.list(1000).find(job => job.transfer?.hash === intent.hash)!;
      expect(stored.status).toBe("transferring"); expect(stored.payoutTx).toBeNull();
    });
    await jobs.deliverArtifact(funded().id, artifact);
    expect(payout.confirmTransfer).toHaveBeenCalledTimes(1);
  });
  it("retains one transfer across a confirmation timeout and retry", async () => {
    vi.mocked(payout.confirmTransfer).mockRejectedValueOnce(new Error("Receipt timeout"));
    const result = await jobs.deliverArtifact(funded().id, artifact);
    expect(result.status).toBe("transferring"); expect(result.payoutTx).toBeNull();
    const intent = result.transfer;
    const retried = await jobs.retryJob(result.id);
    expect(retried.status).toBe("released"); expect(retried.transfer).toEqual(intent);
    expect(payout.prepareTransfer).toHaveBeenCalledTimes(1); expect(serv.evaluateArtifact).toHaveBeenCalledTimes(1);
  });
  it("prevents a conflicting refund after a payout has been claimed", async () => {
    vi.mocked(payout.confirmTransfer).mockRejectedValueOnce(new Error("Unknown outcome"));
    const result = await jobs.deliverArtifact(funded().id, artifact);
    await expect(jobs.refundJob(result.id)).rejects.toThrow("Conflicting");
    expect(payout.prepareTransfer).toHaveBeenCalledTimes(1);
    await jobs.retryJob(result.id); // resolve so later sweeps do not pick it up
  });
  it("deduplicates concurrent appeal polling and preserves terminal receipt", async () => {
    const job = appealed();
    vi.mocked(reppo.pollAppeal).mockResolvedValue({ status: "SETTLED", decision: "accept", score: 90, critique: "fine", raw: {} });
    await Promise.all([jobs.pollJobAppeal(job.id), jobs.pollJobAppeal(job.id)]);
    const result = jobs.requireJob(job.id);
    expect(reppo.pollAppeal).toHaveBeenCalledTimes(1); expect(payout.prepareTransfer).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("released"); expect(result.payoutTx).toBeTruthy();
    expect(result.receipt?.appeal?.status).toBe("SETTLED");
    await jobs.pollJobAppeal(job.id); expect(payout.prepareTransfer).toHaveBeenCalledTimes(1);
  });
  it("holds unknown appeal decisions regardless of score", async () => {
    const job = appealed();
    vi.mocked(reppo.pollAppeal).mockResolvedValue({ status: "SETTLED", decision: "unknown", score: 100, critique: null, raw: {} });
    const result = await jobs.pollJobAppeal(job.id);
    expect(result.status).toBe("needs_review"); expect(payout.prepareTransfer).not.toHaveBeenCalled();
  });
  it("turns an expired appeal into an explicit review hold", async () => {
    const job = appealed(); job.appealDeadline = new Date(0).toISOString(); store.save(job);
    await jobs.sweep(); expect(jobs.requireJob(job.id).status).toBe("needs_review");
  });
  it("restarts seller generation after a pre-artifact failure", async () => {
    const job = funded(); jobs.failJob(job.id, "Generation failed");
    expect((await jobs.retryJob(job.id)).status).toBe("released");
    expect(generateArtifact).toHaveBeenCalledTimes(1);
  });
  it("recovers interrupted verification without authorizing payment", () => {
    const job = funded(); job.status = "verifying"; store.save(job);
    jobs.recoverInterruptedJobs(); expect(jobs.requireJob(job.id).status).toBe("needs_review");
  });
  it("rejects stale saves and keeps nonce reservations after database reopen", () => {
    const dir = mkdtempSync(join(tmpdir(), "signoff-db-test-")); const path = join(dir, "jobs.db");
    let db = new JobStore(path);
    const job = { ...funded(), revision: undefined }; db.save(job);
    const first = db.get(job.id)!; const stale = db.get(job.id)!;
    first.status = "verifying"; db.save(first);
    expect(() => db.save(stale)).toThrow("Concurrent update");
    expect(db.claimPayment("signed-payment", job.id)).toBe(job.id);
    expect(db.claimPayment("signed-payment", "other-job")).toBe(job.id);
    expect(db.reserveNonce("testnet", "processor", "job-a", 7)).toBe(7); db.close();
    db = new JobStore(path);
    expect(db.reserveNonce("testnet", "processor", "job-a", 9)).toBe(7);
    expect(db.reserveNonce("testnet", "processor", "job-b", 7)).toBe(8);
    db.close(); rmSync(dir, { recursive: true });
  });
});

describe("verdict validation", () => {
  it("accepts exactly the complete policy with artifact quotes", () => {
    expect(serv.validateVerdict(rawVerdict(), content, "fixture").criteria).toHaveLength(6);
  });
  it.each(["empty", "omitted", "duplicate", "string_false", "fake_quote"])("rejects %s", variant => {
    const raw = rawVerdict();
    if (variant === "empty") raw.criteria = [];
    if (variant === "omitted") raw.criteria.pop();
    if (variant === "duplicate") raw.criteria[1] = raw.criteria[0]!;
    if (variant === "string_false") (raw.criteria[0] as unknown as { passed: unknown }).passed = "false";
    if (variant === "fake_quote") raw.criteria[0]!.evidence = "This quote is absent";
    expect(() => serv.validateVerdict(raw, content, "fixture")).toThrow();
  });
  it("repairs one malformed provider verdict without weakening quote validation", async () => {
    config.devMockVerdict = false; config.servApiKey = "fixture-key";
    const invalid = rawVerdict(); invalid.criteria[0]!.evidence = "absent quote";
    const fetchMock = liveFetch.mockReset()
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: JSON.stringify(invalid) } }] }))
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: JSON.stringify(rawVerdict()) } }] }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await serv.evaluateArtifact(fundedLiveFixture(), { ...artifact, provider: "serv" }, []);
    expect(result.decision).toBe("pass"); expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("propagates a second invalid verdict so the job will hold funds", async () => {
    config.devMockVerdict = false; config.servApiKey = "fixture-key";
    const fetchMock = liveFetch.mockReset().mockImplementation(() => Promise.resolve(Response.json({ choices: [{ message: { content: JSON.stringify({ decision: "pass", confidence: 1, summary: "No criteria", criteria: [] }) } }] })));
    vi.stubGlobal("fetch", fetchMock);
    await expect(serv.evaluateArtifact(fundedLiveFixture(), { ...artifact, provider: "serv" }, [])).rejects.toThrow("Incomplete");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("holds an incomplete criterion set at the combined-verdict boundary", () => {
    const verdict = { decision: "pass", confidence: 0.99, criteria: [], summary: "OK", model: "fixture", shadowAgent: false, latencyMs: 0 } as ServVerdict;
    expect(combineVerdict([], verdict).decision).toBe("hold");
  });
  it("does not match rejection text as acceptance", () => {
    expect(reppo.normalizeAppealDecision("not accepted")).toBe("reject");
    expect(reppo.normalizeAppealDecision("unapproved")).toBeNull();
    expect(reppo.normalizeAppealDecision("pass")).toBe("accept");
  });
  it("checks the registered section order", () => {
    const checks = deterministicChecks("## Second\ncontent\n## First\ncontent", { ...input.criteria, requiredSections: ["First", "Second"] });
    expect(checks.find(c => c.id === "section_order")?.passed).toBe(false);
  });
});
