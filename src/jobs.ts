import { createHash, randomBytes } from "node:crypto";
import { config } from "./config.js";
import { store } from "./store.js";
import { combineVerdict, deterministicChecks } from "./acceptance.js";
import { generateArtifact } from "./dolphin.js";
import { evaluateArtifact } from "./serv.js";
import { amounts, assertFunded, prepareTransfer, confirmTransfer, sellerAmount } from "./payout.js";
import { pollAppeal, submitAppeal } from "./reppo.js";
import { explorerTxUrl, fromAtomic, toAtomic } from "./kite.js";
import type { AcceptanceCriteria, Artifact, Job, JobSpec, JobStatus } from "./types.js";

const inFlight = new Set<string>();
const transfers = new Map<string, Promise<Job>>();
const polls = new Map<string, Promise<Job>>();

export interface CreateJobInput {
  title?: unknown;
  question?: unknown;
  audience?: unknown;
  criteria?: Partial<AcceptanceCriteria>;
  budgetUsd?: unknown;
  sellerPayout?: unknown;
  sellerName?: unknown;
  demoVariant?: unknown;
  appealWindowSeconds?: unknown;
}

export interface PaymentRecord {
  network: string;
  asset: string;
  amountAtomic: string;
  payer: string | null;
  tx: string | null;
  mode: "x402" | "dev";
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, v]) => `${JSON.stringify(key)}:${stableStringify(v)}`).join(",")}}`;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function text(value: unknown, field: string, max = 4000): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  if (value.length > max) throw new Error(`${field} is too long (max ${max})`);
  return value.trim();
}

function stringList(value: unknown, field: string, max = 20): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${field} must be an array of strings`);
  }
  return value.map((item) => item.trim()).filter(Boolean).slice(0, max);
}

function normalizeCriteria(raw: Partial<AcceptanceCriteria> | undefined): AcceptanceCriteria {
  const value = raw ?? {};
  const requiredSections = stringList(value.requiredSections, "criteria.requiredSections", 12);
  if (requiredSections.length === 0) throw new Error("criteria.requiredSections must contain at least one section");
  const minWordsRaw = Number(value.minWords ?? 250);
  const minCitationsRaw = Number(value.minCitations ?? 3);
  return {
    requiredSections,
    minWords: Number.isFinite(minWordsRaw) ? Math.min(Math.max(Math.round(minWordsRaw), 20), 5000) : 250,
    minCitations: Number.isFinite(minCitationsRaw) ? Math.min(Math.max(Math.round(minCitationsRaw), 0), 20) : 3,
    mustMention: stringList(value.mustMention, "criteria.mustMention", 12),
    forbiddenPhrases: stringList(value.forbiddenPhrases, "criteria.forbiddenPhrases", 20),
  };
}

function normalizeSpec(input: CreateJobInput): JobSpec {
  const sellerPayout = (typeof input.sellerPayout === "string" && input.sellerPayout.trim()) || config.sellerPayoutAddress;
  if (!/^0x[0-9a-fA-F]{40}$/.test(sellerPayout)) {
    throw new Error("sellerPayout must be a valid EVM address (or set SELLER_PAYOUT_ADDRESS)");
  }
  return {
    policyVersion: "brief-v1",
    title: text(input.title, "title", 200),
    question: text(input.question, "question", 2000),
    audience: text(input.audience, "audience", 500),
    criteria: normalizeCriteria(input.criteria),
    budgetUsd: 0, // filled by createJob
    sellerPayout,
    sellerName: typeof input.sellerName === "string" && input.sellerName.trim() ? input.sellerName.trim() : "Signoff demo seller",
  };
}

function normalizeVariant(value: unknown): Artifact["variant"] {
  return value === "sloppy" || value === "injected" ? value : "good";
}

function normalizeWindow(value: unknown): number {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(Math.round(parsed), 600);
}

export function createJob(input: CreateJobInput, priceUsd: number): Job {
  if (!Number.isFinite(priceUsd) || priceUsd < 0.01 || priceUsd > 1) throw new Error("budget must be between $0.01 and $1");
  if (!Number.isInteger(config.feeBps) || config.feeBps < 0 || config.feeBps >= 10000) throw new Error("Invalid fee policy");
  const spec = normalizeSpec(input);
  if (config.sellerPayoutAddress && spec.sellerPayout.toLowerCase() !== config.sellerPayoutAddress.toLowerCase()) throw new Error("This service only supports the configured seller");
  if (/^0x0{40}$/i.test(spec.sellerPayout)) throw new Error("Zero seller address is not allowed");
  spec.budgetUsd = priceUsd;
  const priceAtomic = toAtomic(priceUsd, config.chain.assetDecimals).toString();
  const feeAtomic = ((BigInt(priceAtomic) * BigInt(config.feeBps)) / 10000n).toString();
  const now = new Date().toISOString();

  const job: Job = {
    id: `job_${randomBytes(8).toString("hex")}`,
    createdAt: now,
    updatedAt: now,
    status: "awaiting_payment",
    spec,
    specHash: sha256(stableStringify(spec)),
    criteriaHash: sha256(stableStringify(spec.criteria)),
    demoVariant: normalizeVariant(input.demoVariant),
    appealWindowSeconds: normalizeWindow(input.appealWindowSeconds),
    priceAtomic,
    priceUsd: fromAtomic(BigInt(priceAtomic), config.chain.assetDecimals),
    feeAtomic,
    buyerAddress: null,
    payment: null,
    artifact: null,
    artifactHash: null,
    verdict: null,
    payoutTx: null,
    payoutAt: null,
    refundTx: null,
    refundAt: null,
    refundEligibleAt: null,
    appeal: null,
    receipt: null,
    error: null,
    timeline: [],
  };

  job.timeline.push({ at: now, type: "job.created", detail: `budget $${job.priceUsd}` });
  store.save(job);
  store.event(job.id, "job.created", { budgetUsd: job.priceUsd, demoVariant: job.demoVariant });
  return job;
}

export function attachPayment(jobId: string, payment: PaymentRecord): Job {
  const job = requireJob(jobId);
  if (!["awaiting_payment", "payment_pending"].includes(job.status) || job.payment) throw new Error("Payment already attached or job is not awaiting settlement");
  job.payment = payment;
  assertFunded(job);
  job.status = "held";
  job.buyerAddress = payment.payer;
  job.timeline.push({
    at: new Date().toISOString(),
    type: "payment.settled",
    detail: `${payment.amountAtomic} atomic ${payment.mode === "x402" ? "on Kite" : "(dev mode)"}`,
  });
  store.save(job);
  store.event(jobId, "payment.settled", payment);
  return job;
}

export function startJob(jobId: string): void {
  if (!config.autoDeliver) return;
  void runSeller(jobId);
}

export async function runSeller(jobId: string): Promise<void> {
  if (inFlight.has(jobId)) return;
  inFlight.add(jobId);
  try {
    const job = requireJob(jobId);
    if (job.status !== "held") return;
    assertFunded(job);
    job.status = "delivering";
    job.timeline.push({ at: new Date().toISOString(), type: "seller.started" });
    store.save(job);
    store.event(jobId, "seller.started", { variant: job.demoVariant });

    let artifact = await generateArtifact(job.spec, job.demoVariant);
    if (job.demoVariant === "good") {
      const failed = deterministicChecks(artifact.content, job.spec.criteria).filter((check) => !check.passed);
      if (failed.length > 0) {
        job.timeline.push({
          at: new Date().toISOString(),
          type: "seller.revision_requested",
          detail: failed.map((check) => check.label).join(", "),
        });
        store.save(job);
        artifact = await generateArtifact(
          job.spec,
          job.demoVariant,
          failed.map((check) => `- ${check.label}: ${check.detail}`).join("\n"),
        );
      }
    }

    await deliverArtifact(jobId, artifact);
  } catch (error) {
    failJob(jobId, error);
  } finally {
    inFlight.delete(jobId);
  }
}

export async function deliverArtifact(jobId: string, artifact: Artifact): Promise<Job> {
  const job = requireJob(jobId);
  if (!["held", "delivering", "failed"].includes(job.status)) {
    throw new Error(`job ${jobId} cannot accept a delivery while ${job.status}`);
  }

  assertFunded(job);
  if (job.disposition) throw new Error("Disposition already claimed; only transaction reconciliation is allowed");
  job.artifact = artifact;
  job.artifactHash = sha256(artifact.content);
  job.status = "verifying";
  job.error = null;
  job.timeline.push({
    at: new Date().toISOString(),
    type: "artifact.delivered",
    detail: `${artifact.provider}/${artifact.model}, sha256 ${job.artifactHash.slice(0, 16)}…`,
  });
  store.save(job);
  store.event(jobId, "artifact.delivered", { provider: artifact.provider, model: artifact.model, hash: job.artifactHash });

  const checks = deterministicChecks(artifact.content, job.spec.criteria);

  let serv;
  try {
    serv = await evaluateArtifact(job, artifact, checks);
  } catch (error) {
    job.status = "needs_review";
    job.error = `SERV evaluation failed: ${error instanceof Error ? error.message : String(error)}`;
    job.verdict = combineVerdict(checks, null);
    job.timeline.push({ at: new Date().toISOString(), type: "verification.error", detail: job.error });
    store.save(job);
    store.event(jobId, "verification.error", { error: job.error });
    return job;
  }

  const verdict = combineVerdict(checks, serv);
  job.verdict = verdict;
  job.timeline.push({
    at: new Date().toISOString(),
    type: "verdict.rendered",
    detail: `${verdict.decision}: ${verdict.reason}`,
  });
  store.save(job);
  store.event(jobId, "verdict.rendered", { decision: verdict.decision, reason: verdict.reason });

  if (verdict.decision === "pass") {
    await releaseJob(jobId);
  } else if (verdict.decision === "hold") {
    job.status = "needs_review";
    job.timeline.push({ at: new Date().toISOString(), type: "verification.held", detail: verdict.reason });
    store.save(job);
  } else if (job.appealWindowSeconds > 0) {
    job.status = "refund_pending";
    job.refundEligibleAt = new Date(Date.now() + job.appealWindowSeconds * 1000).toISOString();
    job.timeline.push({
      at: new Date().toISOString(),
      type: "refund.scheduled",
      detail: `eligible at ${job.refundEligibleAt}; seller may appeal`,
    });
    store.save(job);
    store.event(jobId, "refund.scheduled", { eligibleAt: job.refundEligibleAt });
  } else {
    await refundJob(jobId);
  }

  return requireJob(jobId);
}

export function releaseJob(jobId: string): Promise<Job> {
  return settleDisposition(jobId, "payout");
}

export function refundJob(jobId: string): Promise<Job> {
  return settleDisposition(jobId, "refund");
}

function settleDisposition(jobId: string, kind: "payout" | "refund"): Promise<Job> {
  const active = transfers.get(jobId);
  if (active) {
    if (requireJob(jobId).disposition !== kind) return Promise.reject(new Error("Conflicting disposition rejected"));
    return active;
  }
  const task = performDisposition(jobId, kind).finally(() => transfers.delete(jobId));
  transfers.set(jobId, task);
  return task;
}

async function performDisposition(jobId: string, kind: "payout" | "refund"): Promise<Job> {
  let job = requireJob(jobId);
  assertFunded(job);
  if (job.disposition && job.disposition !== kind) throw new Error("Conflicting disposition rejected");
  const terminal = kind === "payout" ? "released" : "refunded";
  if (job.status === terminal) return job;
  if (!job.disposition) {
    if (!["verifying", "refund_pending", "appealed", "needs_review"].includes(job.status)) throw new Error(`Cannot settle while ${job.status}`);
    const appealedPass = job.appeal?.status === "SETTLED" && job.appeal.decision === "accept";
    if (kind === "payout" && job.verdict?.decision !== "pass" && !appealedPass) throw new Error("No valid acceptance decision");
    if (kind === "refund" && job.verdict?.decision !== "fail" && job.appeal?.decision !== "reject") throw new Error("No valid rejection decision");
    if (kind === "payout" && job.verdict?.deterministic.some(c => !c.passed)) throw new Error("Deterministic failure cannot be overridden");
    job.disposition = kind;
    job.status = "transferring";
    job.error = null;
    store.save(job); // Compare-and-swap claims the only allowed money movement.
  }
  try {
    if (!job.transfer) {
      const intent = await prepareTransfer(job);
      job = requireJob(jobId);
      if (!job.transfer) { job.transfer = intent; store.save(job); }
    }
    // Raw signed transaction is durable BEFORE any broadcast. All retries use it.
    await confirmTransfer(job.transfer!);
    job = requireJob(jobId);
    if (job.status === terminal) return job;
    job.status = terminal;
    const at = new Date().toISOString();
    if (kind === "payout") { job.payoutTx = job.transfer!.hash; job.payoutAt = at; }
    else { job.refundTx = job.transfer!.hash; job.refundAt = at; }
    job.error = null;
    job.receipt = buildReceipt(job);
    job.timeline.push({ at, type: `payment.${terminal}`, detail: job.transfer!.mock ? "SIMULATED transfer" : `Confirmed ${job.transfer!.hash}` });
    store.save(job);
    store.event(jobId, `payment.${terminal}`, { tx: job.transfer!.hash, mock: job.transfer!.mock });
  } catch (error) {
    job = requireJob(jobId);
    job.error = `Transfer unresolved; retry reconciles the same transaction: ${error instanceof Error ? error.message : String(error)}`;
    job.status = "transferring";
    store.save(job);
    store.event(jobId, "transfer.unresolved", { error: job.error });
  }
  return requireJob(jobId);
}

export async function appealJob(jobId: string, reason: string): Promise<Job> {
  let job = requireJob(jobId);
  assertFunded(job);
  if (!job.artifact || !["refund_pending", "needs_review"].includes(job.status) || job.disposition) throw new Error("Only held, unfinalized work may be appealed");
  if (job.verdict?.deterministic.some(c => !c.passed)) throw new Error("Deterministic policy failures cannot be appealed");
  if (job.appeal) throw new Error("Only one appeal is allowed per job");
  const previousStatus = job.status;
  job.status = "appealed";
  job.appealDeadline = new Date(Date.now() + (config.reppoMinSettlementMinutes + 10) * 60_000).toISOString();
  store.save(job); // Claim before the external submit; concurrent requests cannot duplicate it.
  try {
    const appeal = await submitAppeal(job, reason);
    job = requireJob(jobId);
    if (job.status !== "appealed") return job;
    job.appeal = appeal;
    job.timeline.push({ at: appeal.submittedAt, type: "appeal.submitted", detail: appeal.evalId ?? "" });
    store.save(job);
    store.event(jobId, "appeal.submitted", { evalId: appeal.evalId });
    return job;
  } catch (error) {
    job = requireJob(jobId);
    job.status = previousStatus;
    job.error = `Appeal submission unresolved: ${error instanceof Error ? error.message : String(error)}`;
    // Keep an ERROR record: an ambiguous response is not permission to resubmit.
    job.appeal = { evalId: null, status: "ERROR", submittedAt: new Date().toISOString(), reason, score: null, decision: null, critique: null };
    store.save(job);
    throw error;
  }
}

export function pollJobAppeal(jobId: string): Promise<Job> {
  const active = polls.get(jobId);
  if (active) return active;
  const task = performPoll(jobId).finally(() => polls.delete(jobId));
  polls.set(jobId, task);
  return task;
}

async function performPoll(jobId: string): Promise<Job> {
  let job = requireJob(jobId);
  if (job.status !== "appealed") return job;
  if (!job.appeal?.evalId) throw new Error("No usable Reppo evaluation; funds remain held");
  const result = await pollAppeal(job.appeal.evalId);
  job = requireJob(jobId);
  if (job.status !== "appealed") return job;
  job.appeal = { ...job.appeal!, ...result };
  job.timeline.push({ at: new Date().toISOString(), type: "appeal.polled", detail: result.status });
  if (result.status === "SETTLED") {
    // Only an explicitly normalized provider decision may authorize disposition.
    // Score never overrides a conflicting or unknown decision.
    if (result.decision !== "accept" && result.decision !== "reject") {
      job.status = "needs_review";
      job.error = "Unknown appeal decision; funds remain held";
    }
  } else if (["DENIED", "FAILED", "ERROR"].includes(result.status)) {
    job.status = "needs_review";
    job.error = "Appeal did not establish acceptance or rejection; funds remain held";
  }
  store.save(job); // Save the result before settlement, and never overwrite its final state.
  store.event(jobId, "appeal.updated", { status: result.status, decision: result.decision });
  if (result.status === "SETTLED" && job.status === "appealed") {
    if (result.decision === "accept") return releaseJob(jobId);
    if (result.decision === "reject") return refundJob(jobId);
  }
  return job;
}

export async function retryJob(jobId: string): Promise<Job> {
  const job = requireJob(jobId);
  assertFunded(job);
  if (job.disposition) return settleDisposition(jobId, job.disposition);
  if (!["failed", "needs_review"].includes(job.status)) throw new Error(`Job ${jobId} cannot retry while ${job.status}`);
  if (job.artifact) {
    job.status = "failed";
    store.save(job);
    return deliverArtifact(jobId, job.artifact);
  }
  job.status = "held";
  job.error = null;
  store.save(job);
  await runSeller(jobId);
  return requireJob(jobId);
}

export function buildReceipt(job: Job) {
  const money = amounts(job);
  return {
    version: 1 as const,
    jobId: job.id,
    createdAt: job.createdAt,
    specHash: job.specHash,
    criteriaHash: job.criteriaHash,
    artifactHash: job.artifactHash,
    verdict: job.verdict?.decision ?? null,
    verdictHash: job.verdict ? sha256(stableStringify(job.verdict)) : null,
    payment: {
      network: job.payment?.network ?? config.chain.network,
      asset: job.payment?.asset ?? config.chain.assetAddress,
      amountAtomic: job.priceAtomic,
      amountUsd: job.priceUsd,
      payer: job.buyerAddress,
      tx: job.payment?.tx ?? null,
    },
    payout: job.payoutTx
      ? {
          to: job.spec.sellerPayout,
          amountAtomic: sellerAmount(job).toString(),
          amountUsd: money.sellerUsd,
          tx: job.payoutTx,
          feeAtomic: job.feeAtomic,
        }
      : null,
    refund: job.refundTx
      ? {
          to: job.buyerAddress ?? "",
          amountAtomic: job.priceAtomic,
          amountUsd: job.priceUsd,
          tx: job.refundTx,
        }
      : null,
    appeal: job.appeal ? { evalId: job.appeal.evalId, status: job.appeal.status } : null,
  };
}

export function publicJob(job: Job) {
  const money = amounts(job);
  return {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    spec: job.spec,
    demoVariant: job.demoVariant,
    specHash: job.specHash,
    criteriaHash: job.criteriaHash,
    artifactHash: job.artifactHash,
    priceUsd: job.priceUsd,
    priceAtomic: job.priceAtomic,
    feeUsd: money.feeUsd,
    sellerProceedsUsd: money.sellerUsd,
    buyerAddress: job.buyerAddress,
    payment: job.payment,
    transfer: job.transfer ? { kind: job.transfer.kind, hash: job.transfer.hash, mock: job.transfer.mock } : null,
    disposition: job.disposition ?? null,
    artifact: job.artifact,
    verdict: job.verdict,
    payoutTx: job.payoutTx,
    payoutExplorer: explorerTxUrl(config.chain, job.payoutTx),
    refundTx: job.refundTx,
    refundExplorer: explorerTxUrl(config.chain, job.refundTx),
    refundEligibleAt: job.refundEligibleAt,
    appeal: job.appeal,
    receipt: job.receipt,
    receiptUrl: `${config.publicBaseUrl}/receipt/${job.id}`,
    error: job.error,
    timeline: job.timeline,
  };
}

export function requireJob(jobId: string): Job {
  const job = store.get(jobId);
  if (!job) throw new Error(`job ${jobId} not found`);
  return job;
}

let sweeping = false;
export async function sweep(): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  try {
    for (const job of store.byStatus("transferring")) {
      if (job.disposition) await settleDisposition(job.id, job.disposition);
    }
    for (const job of store.byStatus("refund_pending")) {
      if (job.refundEligibleAt && Date.parse(job.refundEligibleAt) <= Date.now()) await refundJob(job.id);
    }
    for (const job of store.byStatus("appealed")) {
      if (!job.appealDeadline || Date.parse(job.appealDeadline) <= Date.now()) {
        job.status = "needs_review";
        job.error = "Appeal deadline expired; funds held for manual reconciliation";
        store.save(job);
      } else if (job.appeal?.evalId) {
        try { await pollJobAppeal(job.id); }
        catch (error) { console.error("Appeal pending; funds remain held", job.id, error instanceof Error ? error.message : "provider error"); }
      }
    }
  } finally { sweeping = false; }
}

// A process can exit during generation or verification. Neither state authorizes
// payment, and both can safely resume review of the already-funded job.
export function recoverInterruptedJobs(): void {
  for (const status of ["held", "delivering", "verifying"] as const) {
    for (const job of store.byStatus(status)) {
      job.status = "needs_review";
      job.error = "Processing interrupted; retry required. Funds remain held.";
      store.save(job);
    }
  }
}

export function failJob(jobId: string, error: unknown): Job | null {
  const job = store.get(jobId);
  if (!job) return null;
  if (["released", "refunded", "transferring"].includes(job.status)) return job;
  job.status = "failed";
  job.error = error instanceof Error ? error.message : String(error);
  job.timeline.push({ at: new Date().toISOString(), type: "job.failed", detail: job.error });
  store.save(job);
  store.event(jobId, "job.failed", { error: job.error });
  return job;
}

export function statusLabel(status: JobStatus): string {
  switch (status) {
    case "awaiting_payment": return "Awaiting payment";
    case "payment_pending": return "Payment reconciliation required";
    case "needs_review": return "Funds held for review";
    case "transferring": return "Transfer pending confirmation";
    case "held":
      return "Payment held";
    case "delivering":
      return "Seller delivering";
    case "verifying":
      return "Independent verification";
    case "released":
      return "Released to seller";
    case "refund_pending":
      return "Refund scheduled";
    case "refunded":
      return "Refunded to buyer";
    case "appealed":
      return "Appealed to Reppo";
    case "failed":
      return "Needs attention";
  }
}
