/**
 * Decisive probe: x402 challenge, SERV verdict, Dolphin seller, Reppo appeal.
 *
 * Usage:
 *   npx tsx scripts/probe.ts                 # local server + direct partner calls
 *   npx tsx scripts/probe.ts --url https://... --submit-reppo
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: [".env.local", ".env"], quiet: true });

import { config } from "../src/config.js";
import { deterministicChecks, combineVerdict } from "../src/acceptance.js";
import { generateArtifact, sellerModelMode } from "../src/dolphin.js";
import { evaluateArtifact, servMode } from "../src/serv.js";
import { pollAppeal, submitAppeal } from "../src/reppo.js";
import type { Job, JobSpec } from "../src/types.js";

const args = process.argv.slice(2);
function arg(name: string, fallback = ""): string {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] ?? fallback : fallback;
}
const baseUrl = arg("url", config.publicBaseUrl).replace(/\/+$/, "");
const submitReppo = args.includes("--submit-reppo");

const spec: JobSpec = {
  title: "Probe brief",
  question: "How should agent marketplaces handle post-payment recourse?",
  audience: "Marketplace operators",
  criteria: {
    requiredSections: ["Executive summary", "Market landscape", "Risks", "Recommendation"],
    minWords: 180,
    minCitations: 3,
    mustMention: ["agent", "settlement"],
    forbiddenPhrases: [],
  },
  budgetUsd: 0.05,
  sellerPayout: config.sellerPayoutAddress || "0x000000000000000000000000000000000000dEaD",
  sellerName: "Probe seller",
};

const now = new Date().toISOString();
const probeJob: Job = {
  id: "job_probe",
  createdAt: now,
  updatedAt: now,
  status: "held",
  spec,
  specHash: "probe",
  criteriaHash: "probe",
  demoVariant: "good",
  appealWindowSeconds: 0,
  priceAtomic: "50000000000000000",
  priceUsd: "0.05",
  feeAtomic: "1000000000000000",
  buyerAddress: "0x1111111111111111111111111111111111111111",
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

function line(label: string, value: string): void {
  console.log(`${label.padEnd(18)} ${value}`);
}

async function probeHttp(): Promise<boolean> {
  try {
    const health = await fetch(`${baseUrl}/healthz`);
    const healthBody = (await health.json()) as Record<string, unknown>;
    line("server", `${health.status} · ${JSON.stringify(healthBody)}`);
    const response = await fetch(`${baseUrl}/v1/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(spec),
    });
    const challenge = response.headers.get("PAYMENT-REQUIRED");
    if (response.status !== 402 || !challenge) {
      line("x402 challenge", `FAILED (status ${response.status})`);
      return false;
    }
    const decoded = JSON.parse(Buffer.from(challenge, "base64").toString("utf8"));
    const accepts = decoded.accepts?.[0];
    line("x402 challenge", `402 · ${accepts?.network} · ${accepts?.asset} · ${accepts?.amount} · payTo ${accepts?.payTo}`);
    return true;
  } catch (error) {
    line("x402 challenge", `FAILED (${error instanceof Error ? error.message : String(error)})`);
    return false;
  }
}

async function probeSeller(): Promise<boolean> {
  try {
    const artifact = await generateArtifact(spec, "good");
    const checks = deterministicChecks(artifact.content, spec.criteria);
    const failed = checks.filter((check) => !check.passed);
    line(
      "seller",
      `${sellerModelMode()} · ${artifact.model} · ${artifact.content.split(/\s+/).length} words · ${failed.length} failed checks`,
    );
    if (failed.length) line("seller checks", failed.map((check) => `${check.label}: ${check.detail}`).join(" | "));
    probeJob.artifact = artifact;
    return true;
  } catch (error) {
    line("seller", `FAILED (${error instanceof Error ? error.message : String(error)})`);
    return false;
  }
}

async function probeServ(): Promise<boolean> {
  if (!probeJob.artifact) return false;
  try {
    const checks = deterministicChecks(probeJob.artifact.content, spec.criteria);
    const serv = await evaluateArtifact(probeJob, probeJob.artifact, checks);
    const verdict = combineVerdict(checks, serv);
    line("SERV", `${servMode()} · ${serv.model} · ${serv.latencyMs}ms · shadow=${serv.shadowAgent}`);
    line("SERV verdict", `${serv.decision} (${serv.confidence.toFixed(2)}) · combined ${verdict.decision}`);
    line("SERV summary", serv.summary.slice(0, 240));
    probeJob.verdict = verdict;
    return true;
  } catch (error) {
    line("SERV", `FAILED (${error instanceof Error ? error.message : String(error)})`);
    return false;
  }
}

async function probeReppo(): Promise<boolean> {
  if (!config.reppoApiKey) {
    line("Reppo", "skipped (REPPO_API_KEY not set)");
    return false;
  }
  if (!submitReppo) {
    line("Reppo", "configured; pass --submit-reppo to submit an evaluation");
    return true;
  }
  try {
    const appeal = await submitAppeal(probeJob, "Probe appeal: the verifier may have missed supporting evidence.");
    line("Reppo submit", `${appeal.evalId ?? "no evalId"} · ${appeal.status}`);
    if (appeal.evalId) {
      const polled = await pollAppeal(appeal.evalId);
      line("Reppo poll", `${polled.status} · ${polled.decision ?? "—"} · score ${polled.score ?? "—"}`);
    }
    return true;
  } catch (error) {
    line("Reppo", `FAILED (${error instanceof Error ? error.message : String(error)})`);
    return false;
  }
}

async function main(): Promise<void> {
  console.log("Signoff probe\n");
  const results = {
    x402: await probeHttp(),
    seller: await probeSeller(),
    serv: await probeServ(),
    reppo: await probeReppo(),
  };
  console.log("\nSummary");
  for (const [name, ok] of Object.entries(results)) line(name, ok ? "OK" : "not ready");
  if (!results.x402 || !results.seller || !results.serv) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
