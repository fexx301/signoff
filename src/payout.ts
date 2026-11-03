import type { Hex } from "viem";
import { config } from "./config.js";
import { explorerTxUrl, fromAtomic, walletFromKey } from "./kite.js";
import type { Job } from "./types.js";

export interface TransferResult {
  tx: string;
  explorerUrl: string | null;
  mock: boolean;
}

function processorKey(): Hex {
  if (!config.processorPrivateKey) throw new Error("PROCESSOR_PRIVATE_KEY is not configured");
  return config.processorPrivateKey as Hex;
}

function mockTx(kind: string, jobId: string): string {
  return `mock_${kind}_${jobId}_${Date.now()}`;
}

async function transfer(to: string, atomic: bigint, kind: string, jobId: string): Promise<TransferResult> {
  if (config.devMockPayout) {
    return { tx: mockTx(kind, jobId), explorerUrl: null, mock: true };
  }
  if (!to || !/^0x[0-9a-fA-F]{40}$/.test(to)) {
    throw new Error(`${kind} address is not a valid EVM address: ${to}`);
  }
  if (atomic <= 0n) throw new Error(`${kind} amount must be positive`);

  const wallet = walletFromKey(config.chain, processorKey());
  const hash = await wallet.transfer(to as `0x${string}`, atomic);
  return { tx: hash, explorerUrl: explorerTxUrl(config.chain, hash), mock: false };
}

export function sellerAmount(job: Job): bigint {
  const price = BigInt(job.priceAtomic);
  const fee = BigInt(job.feeAtomic);
  return price - fee;
}

export async function releaseToSeller(job: Job): Promise<TransferResult> {
  const to = job.spec.sellerPayout;
  return transfer(to, sellerAmount(job), "payout", job.id);
}

export async function refundBuyer(job: Job): Promise<TransferResult> {
  const to = job.buyerAddress;
  if (!to) throw new Error("cannot refund: the payment payload did not include a payer address");
  return transfer(to, BigInt(job.priceAtomic), "refund", job.id);
}

export function amounts(job: Job): { priceUsd: string; sellerUsd: string; feeUsd: string } {
  return {
    priceUsd: fromAtomic(BigInt(job.priceAtomic), config.chain.assetDecimals),
    sellerUsd: fromAtomic(sellerAmount(job), config.chain.assetDecimals),
    feeUsd: fromAtomic(BigInt(job.feeAtomic), config.chain.assetDecimals),
  };
}
