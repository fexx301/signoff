export type JobStatus =
  | "held"
  | "delivering"
  | "verifying"
  | "released"
  | "refund_pending"
  | "refunded"
  | "appealed"
  | "failed";

export interface AcceptanceCriteria {
  /** Section headings the artifact must contain, in order. */
  requiredSections: string[];
  /** Minimum word count for the whole artifact. */
  minWords: number;
  /** Minimum number of distinct http(s) citation URLs. */
  minCitations: number;
  /** Terms the artifact must mention (case-insensitive). */
  mustMention: string[];
  /** Phrases that fail the artifact outright (prompt-injection canaries, placeholders). */
  forbiddenPhrases: string[];
}

export interface JobSpec {
  title: string;
  question: string;
  audience: string;
  criteria: AcceptanceCriteria;
  /** What the buyer is willing to pay, in USD. */
  budgetUsd: number;
  /** Where the seller is paid on acceptance. */
  sellerPayout: string;
  sellerName: string;
}

export interface DeterministicCheck {
  id: string;
  label: string;
  passed: boolean;
  detail: string;
}

export interface ServCriterionResult {
  criterion: string;
  passed: boolean;
  evidence: string;
}

export interface ServVerdict {
  decision: "pass" | "fail";
  confidence: number;
  summary: string;
  criteria: ServCriterionResult[];
  model: string;
  latencyMs: number;
  shadowAgent: boolean;
  raw?: unknown;
}

export interface CombinedVerdict {
  decision: "pass" | "fail";
  reason: string;
  deterministic: DeterministicCheck[];
  serv: ServVerdict | null;
  threshold: number;
}

export interface Artifact {
  content: string;
  model: string;
  provider: "dolphin" | "serv" | "mock";
  generatedAt: string;
  /** Demo-only: labels a deliberately bad seller run. */
  variant: "good" | "sloppy" | "injected";
}

export interface ReppoAppeal {
  evalId: string | null;
  status: "PENDING" | "SETTLED" | "DENIED" | "FAILED" | "SUBMITTED" | "ERROR";
  submittedAt: string;
  reason: string;
  score: number | null;
  decision: string | null;
  critique: string | null;
  raw?: unknown;
  error?: string;
}

export interface Receipt {
  version: 1;
  jobId: string;
  createdAt: string;
  specHash: string;
  criteriaHash: string;
  artifactHash: string | null;
  verdict: "pass" | "fail" | null;
  payment: {
    network: string;
    asset: string;
    amountAtomic: string;
    amountUsd: string;
    payer: string | null;
    tx: string | null;
  };
  payout: { to: string; amountAtomic: string; amountUsd: string; tx: string | null; feeAtomic: string } | null;
  refund: { to: string; amountAtomic: string; amountUsd: string; tx: string | null } | null;
  appeal: { evalId: string | null; status: string } | null;
}

export interface Job {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: JobStatus;
  spec: JobSpec;
  specHash: string;
  criteriaHash: string;
  demoVariant: "good" | "sloppy" | "injected";
  appealWindowSeconds: number;

  priceAtomic: string;
  priceUsd: string;
  feeAtomic: string;
  buyerAddress: string | null;
  payment: {
    network: string;
    asset: string;
    amountAtomic: string;
    payer: string | null;
    tx: string | null;
    mode: "x402" | "dev";
  } | null;

  artifact: Artifact | null;
  artifactHash: string | null;
  verdict: CombinedVerdict | null;

  payoutTx: string | null;
  payoutAt: string | null;
  refundTx: string | null;
  refundAt: string | null;
  refundEligibleAt: string | null;

  appeal: ReppoAppeal | null;
  receipt: Receipt | null;
  error: string | null;
  timeline: Array<{ at: string; type: string; detail?: string }>;
}
