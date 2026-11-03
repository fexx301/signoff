import dotenv from "dotenv";
import { privateKeyToAccount } from "viem/accounts";
import { kiteChainByName, type KiteChain } from "./kite.js";

// .env.local wins over .env; both are optional in CI/test.
dotenv.config({ path: [".env.local", ".env"], quiet: true });

function env(key: string, fallback = ""): string {
  return (process.env[key] ?? "").trim() || fallback;
}

function envBool(key: string, fallback = false): boolean {
  const raw = env(key).toLowerCase();
  if (!raw) return fallback;
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function envInt(key: string, fallback: number): number {
  const raw = env(key);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envNumber(key: string, fallback: number): number {
  const raw = env(key);
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const network = env("KITE_NETWORK", "testnet");
const chain = kiteChainByName(network);

const processorKey = env("PROCESSOR_PRIVATE_KEY");
const processorAccount = processorKey ? privateKeyToAccount(processorKey as `0x${string}`) : null;

const payTo = env("PAY_TO") || processorAccount?.address || "";

export interface AppConfig {
  port: number;
  publicBaseUrl: string;
  dbPath: string;

  chain: KiteChain;
  facilitatorUrl: string;
  payTo: `0x${string}` | "";
  processorAccount: ReturnType<typeof privateKeyToAccount> | null;
  processorPrivateKey: string;
  sellerPayoutAddress: `0x${string}` | "";
  sellerSecret: string;
  jobPriceUsd: number;
  feeBps: number;

  servApiKey: string;
  servBaseUrl: string;
  servModel: string;

  dolphinApiKey: string;
  dolphinBaseUrl: string;
  dolphinModel: string;

  reppoApiKey: string;
  reppoBaseUrl: string;
  reppoMinSettlementMinutes: number;

  devSkipPayment: boolean;
  devMockVerdict: boolean;
  devMockPayout: boolean;
  autoDeliver: boolean;
}

export const config: AppConfig = {
  port: envInt("PORT", 8080),
  publicBaseUrl: env("PUBLIC_BASE_URL", `http://localhost:${envInt("PORT", 8080)}`).replace(/\/+$/, ""),
  dbPath: env("DB_PATH", "signoff.db"),

  chain,
  facilitatorUrl: env("FACILITATOR_URL", "https://facilitator.pieverse.io/v2"),
  payTo: payTo as `0x${string}` | "",
  processorAccount,
  processorPrivateKey: processorKey,
  sellerPayoutAddress: env("SELLER_PAYOUT_ADDRESS") as `0x${string}` | "",
  sellerSecret: env("SELLER_SECRET", "dev-seller-secret"),
  jobPriceUsd: envNumber("JOB_PRICE_USD", 0.05),
  feeBps: envInt("FEE_BPS", 200),

  servApiKey: env("SERV_API_KEY"),
  servBaseUrl: env("SERV_BASE_URL", "https://inference-api.openserv.ai/v1"),
  servModel: env("SERV_MODEL", "gpt-5.4-mini"),

  dolphinApiKey: env("DOLPHIN_API_KEY"),
  dolphinBaseUrl: env("DOLPHIN_BASE_URL", "https://lighthouse.dphn.ai/run/text-v/v1"),
  dolphinModel: env("DOLPHIN_MODEL", "deepseek-ai/DeepSeek-V4.1-Flash"),

  reppoApiKey: env("REPPO_API_KEY"),
  reppoBaseUrl: env("REPPO_BASE_URL", "https://eval.reppo.xyz/api/v1"),
  reppoMinSettlementMinutes: envInt("REPPO_SETTLEMENT_MINUTES", 10),

  devSkipPayment: envBool("DEV_SKIP_PAYMENT", false),
  devMockVerdict: envBool("DEV_MOCK_VERDICT", false),
  devMockPayout: envBool("DEV_MOCK_PAYOUT", false),
  autoDeliver: envBool("AUTO_DELIVER", true),
};

export function assertLiveConfig(): string[] {
  const problems: string[] = [];
  if (!config.payTo) problems.push("PAY_TO (or PROCESSOR_PRIVATE_KEY) is required");
  if (!config.devSkipPayment && !config.processorAccount) {
    problems.push("PROCESSOR_PRIVATE_KEY is required to receive, release, and refund payments");
  }
  if (!config.servApiKey && !config.devMockVerdict) {
    problems.push("SERV_API_KEY is required (SERV Reasoning is mandatory)");
  }
  return problems;
}
