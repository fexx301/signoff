import { createHash, randomBytes } from "node:crypto";
import { config } from "./config.js";
import { store } from "./store.js";
import { combineVerdict, deterministicChecks } from "./acceptance.js";
import { generateArtifact } from "./dolphin.js";
import { evaluateArtifact } from "./serv.js";
import { amounts, refundBuyer, releaseToSeller, sellerAmount } from "./payout.js";
import { pollAppeal, submitAppeal } from "./reppo.js";
import { explorerTxUrl, fromAtomic, toAtomic } from "./kite.js";
import type { AcceptanceCriteria, Artifact, Job, JobSpec, JobStatus } from "./types.js";

const inFlight = new Set<string>();

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
  const spec = normalizeSpec(input);
  spec.budgetUsd = priceUsd;
  const priceAtomic = toAtomic(priceUsd, config.chain.assetDecimals).toString();
  const feeAtomic = ((BigInt(priceAtomic) * BigInt(config.feeBps)) / 10000n).toString();
  const now = new Date().toISOString();

  const job: Job = {
    id: `job_${randomBytes(8).toString("hex")}`,
    createdAt: now,
    updatedAt: now,
    status: "held",
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
  job.payment = payment;
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
    job.status = "failed";
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

export async function releaseJob(jobId: string): Promise<Job> {
  const job = requireJob(jobId);
  if (job.status === "released") return job;
  if (!["verifying", "appealed", "failed", "refund_pending"].includes(job.status)) {
    throw new Error(`job ${jobId} cannot be released while ${job.status}`);
  }

  try {
    const result = await releaseToSeller(job);
    job.status = "released";
    job.payoutTx = result.tx;
    job.payoutAt = new Date().toISOString();
    job.error = null;
    job.receipt = buildReceipt(job);
    job.timeline.push({
      at: job.payoutAt,
      type: "payment.released",
      detail: `${fromAtomic(sellerAmount(job), config.chain.assetDecimals)} ${config.chain.assetSymbol} to ${job.spec.sellerPayout}`,
    });
    store.save(job);
    store.event(jobId, "payment.released", { tx: result.tx, mock: result.mock });
  } catch (error) {
    job.status = "failed";
    job.error = `Payout failed: ${error instanceof Error ? error.message : String(error)}`;
    job.timeline.push({ at: new Date().toISOString(), type: "payout.error", detail: job.error });
    store.save(job);
    store.event(jobId, "payout.error", { error: job.error });
  }
  return job;
}

export async function refundJob(jobId: string): Promise<Job> {
  const job = requireJob(jobId);
  if (job.status === "refunded") return job;
  if (!["verifying", "refund_pending", "appealed", "failed"].includes(job.status)) {
    throw new Error(`job ${jobId} cannot be refunded while ${job.status}`);
  }

  try {
    const result = await refundBuyer(job);
    job.status = "refunded";
    job.refundTx = result.tx;
    job.refundAt = new Date().toISOString();
    job.error = null;
    job.receipt = buildReceipt(job);
    job.timeline.push({
      at: job.refundAt,
      type: "payment.refunded",
      detail: `${job.priceUsd} ${config.chain.assetSymbol} to ${job.buyerAddress}`,
    });
    store.save(job);
    store.event(jobId, "payment.refunded", { tx: result.tx, mock: result.mock });
  } catch (error) {
    job.status = "failed";
    job.error = `Refund failed: ${error instanceof Error ? error.message : String(error)}`;
    job.timeline.push({ at: new Date().toISOString(), type: "refund.error", detail: job.error });
    store.save(job);
    store.event(jobId, "refund.error", { error: job.error });
  }
  return job;
}

export async function appealJob(jobId: string, reason: string): Promise<Job> {
  const job = requireJob(jobId);
  if (!job.artifact) throw new Error("job has no delivered artifact to appeal");
  if (job.appeal?.evalId && job.appeal.status === "PENDING") {
    throw new Error(`an appeal is already pending (${job.appeal.evalId})`);
  }

  const previousStatus = job.status;
  if (job.status === "refund_pending") {
    job.status = "appealed";
    job.refundEligibleAt = null;
    store.save(job);
  }

  try {
    const appeal = await submitAppeal(job, reason);
    job.appeal = appeal;
    job.timeline.push({
      at: appeal.submittedAt,
      type: "appeal.submitted",
      detail: `${appeal.evalId ?? "no evalId"} — ${reason}`,
    });
    if (previousStatus === "refund_pending") job.status = "appealed";
    store.save(job);
    store.event(jobId, "appeal.submitted", { evalId: appeal.evalId, reason });
    return job;
  } catch (error) {
    if (previousStatus === "refund_pending") {
      job.status = "refund_pending";
      job.refundEligibleAt = new Date().toISOString();
      store.save(job);
    }
    throw error;
  }
}

export async function pollJobAppeal(jobId: string): Promise<Job> {
  const job = requireJob(jobId);
  if (!job.appeal?.evalId) throw new Error("job has no Reppo evalId");
  if (job.appeal.status !== "PENDING" && job.appeal.status !== "SUBMITTED") return job;

  const result = await pollAppeal(job.appeal.evalId);
  job.appeal = {
    ...job.appeal,
    status: result.status,
    score: result.score,
    decision: result.decision,
    critique: result.critique,
    raw: result.raw,
  };
  job.timeline.push({
    at: new Date().toISOString(),
    type: "appeal.polled",
    detail: `${result.status}${result.decision ? ` / ${result.decision}` : ""}`,
  });

  if (result.status === "SETTLED") {
    const accepted = /accept|pass|approve/i.test(result.decision ?? "") || (result.score ?? 0) >= 60;
    if (job.status === "appealed") {
      if (accepted) await releaseJob(jobId);
      else await refundJob(jobId);
    }
  } else if (result.status === "DENIED" || result.status === "FAILED") {
    if (job.status === "appealed") await refundJob(jobId);
  }

  store.save(job);
  store.event(jobId, "appeal.updated", { status: result.status, decision: result.decision, score: result.score });
  return job;
}

export async function retryJob(jobId: string): Promise<Job> {
  const job = requireJob(jobId);
  if (job.status !== "failed") throw new Error(`job ${jobId} is ${job.status}, not failed`);
  if (job.artifact) return deliverArtifact(jobId, job.artifact);
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

export async function sweep(): Promise<void> {
  const now = Date.now();
  for (const job of store.byStatus("refund_pending")) {
    if (!job.refundEligibleAt || Date.parse(job.refundEligibleAt) > now) continue;
    try {
      await refundJob(job.id);
    } catch (error) {
      console.error("refund sweep failed", job.id, error);
    }
  }
  for (const job of store.byStatus("appealed")) {
    if (!job.appeal?.evalId) continue;
    try {
      await pollJobAppeal(job.id);
    } catch (error) {
      console.error("appeal sweep failed", job.id, error);
    }
  }
}

export function failJob(jobId: string, error: unknown): Job | null {
  const job = store.get(jobId);
  if (!job) return null;
  job.status = "failed";
  job.error = error instanceof Error ? error.message : String(error);
  job.timeline.push({ at: new Date().toISOString(), type: "job.failed", detail: job.error });
  store.save(job);
  store.event(jobId, "job.failed", { error: job.error });
  return job;
}

export function statusLabel(status: JobStatus): string {
  switch (status) {
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
