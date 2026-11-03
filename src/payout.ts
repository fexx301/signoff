import type { Hex } from "viem";
import { config } from "./config.js";
import { fromAtomic, walletFromKey } from "./kite.js";
import { store } from "./store.js";
import type { Job, TransferIntent } from "./types.js";

export function assertFunded(job: Job): void {
  const payment = job.payment;
  if (!payment || !payment.payer || !/^0x[0-9a-fA-F]{40}$/.test(payment.payer) || /^0x0{40}$/i.test(payment.payer) ||
      payment.amountAtomic !== job.priceAtomic || payment.network !== config.chain.network ||
      payment.asset.toLowerCase() !== config.chain.assetAddress.toLowerCase()) {
    throw new Error("A settled payment matching this job is required");
  }
  const simulated = payment.mode === "dev" || job.verdict?.serv?.model === "mock" || job.artifact?.provider === "mock";
  if (simulated && !(config.devSkipPayment && config.devMockVerdict && config.devMockPayout)) {
    throw new Error("Simulated payment, seller, or verdict cannot authorize live transfers");
  }
  if (payment.mode === "x402" && (!payment.tx || !/^0x[0-9a-fA-F]{64}$/.test(payment.tx))) {
    throw new Error("Confirmed incoming settlement transaction is required");
  }
}

export function sellerAmount(job: Job): bigint {
  return BigInt(job.priceAtomic) - BigInt(job.feeAtomic);
}

export async function prepareTransfer(job: Job): Promise<TransferIntent> {
  assertFunded(job);
  const kind = job.disposition;
  if (!kind) throw new Error("No disposition has been claimed");
  const to = kind === "payout" ? job.spec.sellerPayout : job.buyerAddress!;
  const atomic = kind === "payout" ? sellerAmount(job) : BigInt(job.priceAtomic);
  if (!/^0x[0-9a-fA-F]{40}$/.test(to) || /^0x0{40}$/i.test(to) || atomic <= 0n) throw new Error("Invalid transfer");
  if (config.devMockPayout) {
    return { kind, to, amountAtomic: atomic.toString(), hash: `mock_${kind}_${job.id}`, rawTransaction: null, mock: true };
  }
  if (!config.processorPrivateKey) throw new Error("PROCESSOR_PRIVATE_KEY is required");
  const wallet = walletFromKey(config.chain, config.processorPrivateKey as Hex);
  const nonce = store.reserveNonce(config.chain.network, wallet.address.toLowerCase(), job.id, await wallet.pendingNonce());
  const signed = await wallet.prepareTransfer(to as Hex, atomic, nonce);
  return { kind, to, amountAtomic: atomic.toString(), ...signed, mock: false };
}

export async function confirmTransfer(intent: TransferIntent): Promise<void> {
  if (intent.mock) {
    if (!config.devMockPayout) throw new Error("Cannot confirm a simulated transfer in live mode");
    return;
  }
  if (!intent.rawTransaction || !config.processorPrivateKey) throw new Error("Signed transaction and processor key required");
  const wallet = walletFromKey(config.chain, config.processorPrivateKey as Hex);
  await wallet.confirmTransfer(intent.rawTransaction as Hex, intent.hash as Hex, intent.to as Hex, BigInt(intent.amountAtomic));
}

export function amounts(job: Job): { priceUsd: string; sellerUsd: string; feeUsd: string } {
  return {
    priceUsd: fromAtomic(BigInt(job.priceAtomic), config.chain.assetDecimals),
    sellerUsd: fromAtomic(sellerAmount(job), config.chain.assetDecimals),
    feeUsd: fromAtomic(BigInt(job.feeAtomic), config.chain.assetDecimals),
  };
}
