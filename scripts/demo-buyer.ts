/**
 * Demo buyer: pays a Signoff job through x402 and polls the receipt.
 *
 * With BUYER_PRIVATE_KEY set (a Kite testnet wallet holding pieUSD), this
 * performs the full 402 -> EIP-3009 -> settle flow. Without a key, use --dry
 * to inspect the challenge, or pay with `kpass agent:session execute`.
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: [".env.local", ".env"], quiet: true });

import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";
import { decodePaymentResponseHeader } from "@x402/fetch";
import { config } from "../src/config.js";

const args = process.argv.slice(2);
function arg(name: string, fallback = ""): string {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] ?? fallback : fallback;
}
const dry = args.includes("--dry");
const baseUrl = arg("url", config.publicBaseUrl).replace(/\/+$/, "");
const variant = (arg("variant", "good") as "good" | "sloppy" | "injected") ?? "good";
const appealWindow = Number(arg("appeal-window", "0")) || 0;

const body = {
  title: `Post-payment recourse for agent marketplaces (${variant})`,
  question:
    "How should agent marketplaces handle post-payment recourse when a paid artifact does not meet the buyer's pre-registered acceptance criteria?",
  audience: "Marketplace operators and agent-platform product teams",
  criteria: {
    requiredSections: ["Executive summary", "Market landscape", "Risks", "Recommendation"],
    minWords: 180,
    minCitations: 3,
    mustMention: ["agent", "settlement"],
    forbiddenPhrases: [],
  },
  budgetUsd: 0.05,
  sellerPayout: config.sellerPayoutAddress,
  sellerName: "Signoff demo seller",
  demoVariant: variant,
  appealWindowSeconds: appealWindow,
};

async function post(body: unknown, fetchImpl: typeof fetch): Promise<Response> {
  return fetchImpl(`${baseUrl}/v1/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function main(): Promise<void> {
  console.log(`Signoff demo buyer -> ${baseUrl}`);
  console.log(`  variant ${variant} · budget $${body.budgetUsd} · appeal window ${appealWindow}s`);

  if (dry || !process.env.BUYER_PRIVATE_KEY) {
    if (!dry) console.log("\nBUYER_PRIVATE_KEY is not set; running the dry challenge only.");
    const response = await post(body, fetch);
    console.log(`  status ${response.status}`);
    const challenge = response.headers.get("PAYMENT-REQUIRED");
    if (challenge) {
      const decoded = JSON.parse(Buffer.from(challenge, "base64").toString("utf8"));
      console.log("  challenge:");
      console.log(JSON.stringify(decoded, null, 2));
    } else {
      console.log(await response.text());
    }
    console.log("\nTo pay with Kite Passport, run:");
    console.log(
      `  kpass agent:session execute --url ${baseUrl}/v1/jobs --method POST --headers '{"content-type":"application/json"}' --body '${JSON.stringify(
        body,
      )}' --output json`,
    );
    return;
  }

  const account = privateKeyToAccount(process.env.BUYER_PRIVATE_KEY as `0x${string}`);
  console.log(`  buyer ${account.address}`);
  const fetchWithPayment = wrapFetchWithPaymentFromConfig(fetch, {
    schemes: [{ network: config.chain.network, client: new ExactEvmScheme(account) }],
  });

  const response = await post(body, fetchWithPayment as typeof fetch);
  const text = await response.text();
  if (!response.ok) {
    console.error(`  payment failed (${response.status}): ${text}`);
    process.exitCode = 1;
    return;
  }

  const job = JSON.parse(text) as { id: string; receiptUrl: string };
  const paymentHeader = response.headers.get("PAYMENT-RESPONSE");
  if (paymentHeader) {
    try {
      console.log("  settlement:", decodePaymentResponseHeader(paymentHeader));
    } catch {
      console.log("  settlement header:", paymentHeader);
    }
  }
  console.log(`  job ${job.id}`);
  console.log(`  receipt ${job.receiptUrl}`);

  const deadline = Date.now() + 90_000;
  let last = "";
  while (Date.now() < deadline) {
    const poll = await fetch(`${baseUrl}/v1/jobs/${job.id}`);
    const current = (await poll.json()) as {
      status: string;
      verdict?: { decision?: string; reason?: string } | null;
      payoutTx?: string | null;
      refundTx?: string | null;
      error?: string | null;
    };
    if (current.status !== last) {
      console.log(`  status ${current.status}${current.verdict?.decision ? ` · verdict ${current.verdict.decision}` : ""}`);
      last = current.status;
    }
    if (["released", "refunded", "failed"].includes(current.status)) {
      console.log(`  verdict: ${current.verdict?.reason ?? "—"}`);
      if (current.payoutTx) console.log(`  payout tx: ${current.payoutTx}`);
      if (current.refundTx) console.log(`  refund tx: ${current.refundTx}`);
      if (current.error) console.log(`  error: ${current.error}`);
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
