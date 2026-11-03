import express, { type NextFunction, type Request, type Response } from "express";
import { config } from "./config.js";
import { buildX402, resolveBudgetUsd, settleVerifiedPayment, x402Gate, type VerifiedPayment } from "./x402.js";
import {
  appealJob,
  attachPayment,
  createJob,
  deliverArtifact,
  failJob,
  pollJobAppeal,
  publicJob,
  requireJob,
  retryJob,
  startJob,
  statusLabel,
} from "./jobs.js";
import { store } from "./store.js";
import { sellerModelMode } from "./dolphin.js";
import { servMode } from "./serv.js";
import { explorerTxUrl } from "./kite.js";
import type { Artifact, Job } from "./types.js";

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function short(value: string | null | undefined, head = 10, tail = 8): string {
  if (!value) return "—";
  return value.length <= head + tail + 1 ? value : `${value.slice(0, head)}…${value.slice(-tail)}`;
}

function requireSeller(req: Request, res: Response, next: NextFunction): void {
  const provided = req.header("x-signoff-key") ?? req.header("authorization")?.replace(/^Bearer\s+/i, "");
  if (!provided || provided !== config.sellerSecret) {
    res.status(401).json({ error: "seller_auth_required" });
    return;
  }
  next();
}

const STATUS_COLORS: Record<string, string> = {
  held: "#b7791f",
  delivering: "#2b6cb0",
  verifying: "#6b46c1",
  released: "#2f855a",
  refund_pending: "#c05621",
  refunded: "#2f855a",
  appealed: "#6b46c1",
  failed: "#c53030",
};

function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: dark; --bg:#0b0d10; --panel:#12161c; --line:#242b35; --ink:#e8eaed; --muted:#8b95a5; --accent:#7dd3a8; --warn:#f6ad55; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
  a { color:var(--accent); text-decoration:none; }
  a:hover { text-decoration:underline; }
  .wrap { max-width: 960px; margin: 0 auto; padding: 48px 24px 80px; }
  header { display:flex; align-items:baseline; justify-content:space-between; gap:16px; margin-bottom:40px; }
  .brand { font-size:20px; font-weight:700; letter-spacing:-0.02em; }
  .brand span { color:var(--accent); }
  .tag { color:var(--muted); font-size:13px; }
  h1 { font-size:34px; line-height:1.15; letter-spacing:-0.03em; margin:0 0 12px; }
  h2 { font-size:13px; text-transform:uppercase; letter-spacing:0.12em; color:var(--muted); margin:40px 0 14px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:14px; padding:22px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:12px; }
  .kv { padding:12px 0; border-bottom:1px solid var(--line); }
  .kv:last-child { border-bottom:0; }
  .k { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:0.08em; }
  .v { margin-top:3px; word-break:break-word; }
  .mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12.5px; }
  .badge { display:inline-block; padding:4px 10px; border-radius:999px; font-size:12px; font-weight:700; letter-spacing:0.04em; text-transform:uppercase; }
  .muted { color:var(--muted); }
  .row { display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
  .btn { display:inline-block; padding:10px 14px; border:1px solid var(--line); border-radius:10px; color:var(--ink); background:#171c23; }
  .btn:hover { border-color:var(--accent); text-decoration:none; }
  ul { padding-left:18px; }
  li { margin:6px 0; }
  .pass { color:var(--accent); }
  .fail { color:#fc8181; }
  .timeline { list-style:none; padding:0; margin:0; }
  .timeline li { border-left:2px solid var(--line); padding:0 0 16px 18px; position:relative; }
  .timeline li::before { content:""; position:absolute; left:-5px; top:5px; width:8px; height:8px; border-radius:50%; background:var(--accent); }
  .foot { margin-top:48px; color:var(--muted); font-size:12px; border-top:1px solid var(--line); padding-top:18px; }
  .notice { border:1px solid #3d2f1a; background:#1c1710; color:#f6d9a8; border-radius:12px; padding:14px 16px; font-size:13px; }
  @media (max-width:640px){ h1{font-size:26px} .wrap{padding:28px 16px 60px} }
</style>
</head>
<body><div class="wrap">
<header><div class="brand">Sign<span>off</span></div><div class="tag">x402 settles on 200 OK. Signoff settles on proof.</div></header>
${body}
<div class="foot">Signoff is a testnet prototype. The processor is the merchant of record and holds funds during acceptance; this is disclosed custody, not trustless escrow.</div>
</div></body></html>`;
}

function landing(jobs: Job[]): string {
  const rows = jobs
    .map(
      (job) => `<div class="kv"><div class="row"><span class="badge" style="background:${STATUS_COLORS[job.status]}22;color:${STATUS_COLORS[job.status]}">${escapeHtml(
        statusLabel(job.status),
      )}</span><a href="/receipt/${escapeHtml(job.id)}">${escapeHtml(job.spec.title)}</a><span class="muted mono">${escapeHtml(
        job.id,
      )}</span></div><div class="muted">${escapeHtml(job.spec.question)}</div></div>`,
    )
    .join("");
  return shell(
    "Signoff — acceptance escrow for agent payments",
    `<h1>Acceptance escrow for agent payments.</h1>
<p class="muted" style="font-size:17px;max-width:720px">A buyer agent pays through a Kite Passport session. Signoff holds the payment, an independent SERV verifier checks the delivered artifact against criteria registered before delivery, and the money is released only on proof — otherwise the buyer is refunded.</p>
<div class="row" style="margin:24px 0 8px"><a class="btn" href="/v1/jobs">Recent jobs (JSON)</a><a class="btn" href="/healthz">Health</a></div>
<h2>Recent receipts</h2>
<div class="card">${rows || '<p class="muted">No jobs yet. Create one with the demo buyer or a Kite Passport session.</p>'}</div>
<h2>How it works</h2>
<div class="grid">
  <div class="card"><strong>1. Register criteria</strong><p class="muted">The buyer fixes the spec, rubric, and budget before delivery. Hashes go into the receipt.</p></div>
  <div class="card"><strong>2. Pay through Kite</strong><p class="muted">The buyer's approved session pays the x402 challenge on Kite testnet. Signoff, as payee, holds the funds.</p></div>
  <div class="card"><strong>3. Verify, then settle</strong><p class="muted">SERV returns a schema-bound verdict with quoted evidence. Pass releases to the seller; fail refunds the buyer.</p></div>
</div>
<div class="notice" style="margin-top:24px"><strong>Trust model:</strong> this MVP is custodial on testnet. The processor receives the payment and controls delayed settlement. A production deployment would replace the processor with a non-custodial escrow contract and an arbitrator role.</div>`,
  );
}

function receiptPage(job: Job): string {
  const verdict = job.verdict;
  const checks = verdict?.deterministic ?? [];
  const serv = verdict?.serv;
  const statusColor = STATUS_COLORS[job.status] ?? "#8b95a5";
  const paymentTx = job.payment?.tx ? explorerTxUrl(config.chain, job.payment.tx) : null;
  const payoutUrl = explorerTxUrl(config.chain, job.payoutTx);
  const refundUrl = explorerTxUrl(config.chain, job.refundTx);

  const checkItems = checks
    .map(
      (check) =>
        `<li><span class="${check.passed ? "pass" : "fail"}">${check.passed ? "PASS" : "FAIL"}</span> — <strong>${escapeHtml(
          check.label,
        )}</strong> <span class="muted">${escapeHtml(check.detail)}</span></li>`,
    )
    .join("");

  const criteriaItems = (serv?.criteria ?? [])
    .map(
      (criterion) =>
        `<li><span class="${criterion.passed ? "pass" : "fail"}">${criterion.passed ? "PASS" : "FAIL"}</span> — ${escapeHtml(
          criterion.criterion,
        )}<div class="muted mono" style="margin-top:4px">“${escapeHtml(criterion.evidence)}”</div></li>`,
    )
    .join("");

  const timeline = job.timeline
    .map(
      (event) =>
        `<li><div class="mono muted">${escapeHtml(event.at)} · ${escapeHtml(event.type)}</div>${
          event.detail ? `<div>${escapeHtml(event.detail)}</div>` : ""
        }</li>`,
    )
    .join("");

  const money = (label: string, value: string) => `<div class="kv"><div class="k">${escapeHtml(label)}</div><div class="v">${value}</div></div>`;

  return shell(
    `Signoff receipt — ${job.spec.title}`,
    `<div class="row" style="justify-content:space-between;align-items:flex-start">
  <div><h1>${escapeHtml(job.spec.title)}</h1><div class="muted">${escapeHtml(job.spec.question)}</div></div>
  <span class="badge" style="background:${statusColor}22;color:${statusColor}">${escapeHtml(statusLabel(job.status))}</span>
</div>

<div class="card" style="margin-top:24px">
  ${money("Job", `<span class="mono">${escapeHtml(job.id)}</span>`)}
  ${money("Audience", escapeHtml(job.spec.audience))}
  ${money("Buyer", `<span class="mono">${escapeHtml(job.buyerAddress ?? "dev mode")}</span>`)}
  ${money("Seller", `${escapeHtml(job.spec.sellerName)} · <span class="mono">${escapeHtml(job.spec.sellerPayout)}</span>`)}
  ${money("Price", `${escapeHtml(job.priceUsd)} ${escapeHtml(config.chain.assetSymbol)} <span class="muted">(fee ${escapeHtml(
    job.feeAtomic,
  )} atomic, ${config.feeBps / 100}%)</span>`)}
  ${money("Payment tx", paymentTx ? `<a class="mono" href="${escapeHtml(paymentTx)}">${escapeHtml(job.payment?.tx ?? "")}</a>` : "—")}
  ${money("Payout tx", payoutUrl ? `<a class="mono" href="${escapeHtml(payoutUrl)}">${escapeHtml(job.payoutTx ?? "")}</a>` : "—")}
  ${money("Refund tx", refundUrl ? `<a class="mono" href="${escapeHtml(refundUrl)}">${escapeHtml(job.refundTx ?? "")}</a>` : "—")}
</div>

<h2>Verdict</h2>
<div class="card">
  <div class="row" style="justify-content:space-between"><strong class="${verdict?.decision === "pass" ? "pass" : "fail"}">${
    verdict ? verdict.decision.toUpperCase() : "PENDING"
  }</strong><span class="muted mono">${serv ? `${escapeHtml(serv.model)} · ${serv.latencyMs}ms${serv.shadowAgent ? " · shadow-agent" : ""}` : ""}</span></div>
  <p>${escapeHtml(verdict?.reason ?? "Verification has not run yet.")}</p>
  ${serv ? `<div class="kv"><div class="k">SERV confidence</div><div class="v">${(serv.confidence * 100).toFixed(0)}%</div></div>` : ""}
  ${serv ? `<div class="kv"><div class="k">SERV summary</div><div class="v">${escapeHtml(serv.summary)}</div></div>` : ""}
</div>

${checks.length ? `<h2>Deterministic checks</h2><div class="card"><ul>${checkItems}</ul></div>` : ""}
${criteriaItems ? `<h2>Semantic criteria (SERV)</h2><div class="card"><ul>${criteriaItems}</ul></div>` : ""}

<h2>Receipt</h2>
<div class="card">
  ${money("Spec hash", `<span class="mono">${escapeHtml(job.specHash)}</span>`)}
  ${money("Criteria hash", `<span class="mono">${escapeHtml(job.criteriaHash)}</span>`)}
  ${money("Artifact hash", `<span class="mono">${escapeHtml(job.artifactHash ?? "—")}</span>`)}
  ${money("Network", `<span class="mono">${escapeHtml(config.chain.network)} · ${escapeHtml(config.chain.assetSymbol)}</span>`)}
  ${job.appeal ? money("Reppo appeal", `<span class="mono">${escapeHtml(job.appeal.evalId ?? "—")}</span> · ${escapeHtml(job.appeal.status)}`) : ""}
</div>

${job.artifact ? `<h2>Delivered artifact</h2><div class="card"><div class="muted mono" style="margin-bottom:10px">${escapeHtml(
    job.artifact.provider,
  )}/${escapeHtml(job.artifact.model)} · ${escapeHtml(job.artifact.generatedAt)}</div><pre style="white-space:pre-wrap;margin:0;font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace">${escapeHtml(
    job.artifact.content,
  )}</pre></div>` : ""}

<h2>Timeline</h2>
<div class="card"><ul class="timeline">${timeline}</ul></div>

<div class="notice" style="margin-top:24px">This receipt binds the pre-registered spec, the delivered artifact, the verifier verdict, and the settlement transactions. Testnet demo; custody is disclosed.</div>`,
  );
}

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);
  app.use(express.json({ limit: "1mb" }));

  const runtime = buildX402();

  app.get("/healthz", (_req, res) => {
    res.json({
      ok: true,
      product: "Signoff",
      network: config.chain.network,
      asset: config.chain.assetSymbol,
      payTo: config.payTo || null,
      facilitator: config.facilitatorUrl,
      serv: servMode(),
      sellerModel: sellerModelMode(),
      reppo: Boolean(config.reppoApiKey),
      devSkipPayment: config.devSkipPayment,
      devMockPayout: config.devMockPayout,
      publicBaseUrl: config.publicBaseUrl,
    });
  });

  app.get("/", (_req, res) => {
    res.type("html").send(landing(store.list(20)));
  });

  app.get("/v1/jobs", (_req, res) => {
    res.json({ jobs: store.list(50).map(publicJob) });
  });

  app.post("/v1/jobs", x402Gate(runtime), async (req, res) => {
    const budgetUsd = resolveBudgetUsd(req.body);
    let job: Job;
    try {
      job = createJob(req.body ?? {}, budgetUsd);
    } catch (error) {
      res.status(400).json({ error: "invalid_job", message: error instanceof Error ? error.message : String(error) });
      return;
    }

    const payment = res.locals.x402 as VerifiedPayment | undefined;
    if (payment) {
      const context = res.locals.x402Context as Parameters<typeof settleVerifiedPayment>[2];
      const settled = await settleVerifiedPayment(runtime, payment, context);
      if (!settled.ok) {
        failJob(job.id, `Settlement failed: ${settled.error}`);
        res.status(402).json({ error: "settlement_failed", message: settled.error, jobId: job.id });
        return;
      }
      for (const [key, value] of Object.entries(settled.headers)) res.setHeader(key, value);
      job = attachPayment(job.id, {
        network: payment.paymentRequirements.network,
        asset: payment.paymentRequirements.asset,
        amountAtomic: payment.paymentRequirements.amount,
        payer: settled.payer,
        tx: settled.transaction,
        mode: "x402",
      });
    } else if (config.devSkipPayment) {
      job = attachPayment(job.id, {
        network: config.chain.network,
        asset: config.chain.assetAddress,
        amountAtomic: job.priceAtomic,
        payer:
          typeof req.body?.buyerAddress === "string" && /^0x[0-9a-fA-F]{40}$/.test(req.body.buyerAddress)
            ? req.body.buyerAddress
            : "0x1111111111111111111111111111111111111111",
        tx: null,
        mode: "dev",
      });
    } else {
      res.status(402).json({ error: "payment_required" });
      return;
    }

    startJob(job.id);
    res.status(201).json(publicJob(requireJob(job.id)));
  });

  app.get("/v1/jobs/:id", (req, res) => {
    const job = store.get(String(req.params.id));
    if (!job) {
      res.status(404).json({ error: "job_not_found" });
      return;
    }
    res.json(publicJob(job));
  });

  app.post("/v1/jobs/:id/deliver", requireSeller, async (req, res) => {
    const content = req.body?.content;
    if (typeof content !== "string" || content.trim().length < 20) {
      res.status(400).json({ error: "artifact_content_required" });
      return;
    }
    const artifact: Artifact = {
      content,
      model: typeof req.body?.model === "string" ? req.body.model : "seller-agent",
      provider: req.body?.provider === "dolphin" || req.body?.provider === "serv" ? req.body.provider : "mock",
      generatedAt: new Date().toISOString(),
      variant: req.body?.variant === "sloppy" || req.body?.variant === "injected" ? req.body.variant : "good",
    };
    try {
      const job = await deliverArtifact(String(req.params.id), artifact);
      res.json(publicJob(job));
    } catch (error) {
      res.status(409).json({ error: "delivery_rejected", message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/v1/jobs/:id/appeal", requireSeller, async (req, res) => {
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
    if (!reason) {
      res.status(400).json({ error: "appeal_reason_required" });
      return;
    }
    try {
      const job = await appealJob(String(req.params.id), reason);
      res.status(202).json(publicJob(job));
    } catch (error) {
      res.status(409).json({ error: "appeal_rejected", message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/v1/jobs/:id/poll-appeal", requireSeller, async (req, res) => {
    try {
      const job = await pollJobAppeal(String(req.params.id));
      res.json(publicJob(job));
    } catch (error) {
      res.status(409).json({ error: "appeal_poll_failed", message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/v1/jobs/:id/retry", requireSeller, async (req, res) => {
    try {
      const job = await retryJob(String(req.params.id));
      res.json(publicJob(job));
    } catch (error) {
      res.status(409).json({ error: "retry_failed", message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/receipt/:id", (req, res) => {
    const job = store.get(String(req.params.id));
    if (!job) {
      res.status(404).type("html").send(shell("Not found", `<h1>Receipt not found</h1><p class="muted">No job with id ${escapeHtml(String(req.params.id))}.</p>`));
      return;
    }
    res.type("html").send(receiptPage(job));
  });

  app.get("/api/receipt/:id", (req, res) => {
    const job = store.get(String(req.params.id));
    if (!job) {
      res.status(404).json({ error: "job_not_found" });
      return;
    }
    res.json({ receipt: job.receipt ?? null, job: publicJob(job) });
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error("unhandled", error);
    if (res.headersSent) return;
    res.status(500).json({ error: "internal_error", message: error instanceof Error ? error.message : String(error) });
  });

  return app;
}
