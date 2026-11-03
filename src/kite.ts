import type { AssetAmount, MoneyParser, Network } from "@x402/core/types";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  encodeFunctionData,
  decodeEventLog,
  keccak256,
  TransactionReceiptNotFoundError,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

/**
 * One Kite network Signoff can charge on. The payer signs an EIP-3009
 * transferWithAuthorization, so the asset must implement EIP-3009 and the
 * EIP-712 domain must match the token exactly.
 */
export interface KiteChain {
  network: Network;
  chainId: number;
  rpcUrl: string;
  explorerUrl: string;
  assetAddress: Address;
  assetSymbol: string;
  assetDecimals: number;
  eip712Name: string;
  eip712Version: string;
}

/** Kite mainnet: Bridged USDC (USDC.e), 6 decimals. */
export const KITE_MAINNET: KiteChain = {
  network: "eip155:2366",
  chainId: 2366,
  rpcUrl: "https://rpc.gokite.ai",
  explorerUrl: "https://kitescan.ai",
  assetAddress: "0x7aB6f3ed87C42eF0aDb67Ed95090f8bF5240149e",
  assetSymbol: "USDC.e",
  assetDecimals: 6,
  eip712Name: "Bridged USDC (Kite AI)",
  eip712Version: "2",
};

/** Kite testnet: pieUSD, 18 decimals. Kite Passport sandbox agents pay with this. */
export const KITE_TESTNET: KiteChain = {
  network: "eip155:2368",
  chainId: 2368,
  rpcUrl: "https://rpc-testnet.gokite.ai",
  explorerUrl: "https://testnet.kitescan.ai",
  assetAddress: "0x38129cf4CE5E183eFF248F42A7D345Bb1B47621A",
  assetSymbol: "pieUSD",
  assetDecimals: 18,
  eip712Name: "pieUSD",
  eip712Version: "1",
};

export const FACILITATOR_URL = "https://facilitator.pieverse.io/v2";

export function kiteChainByName(name: string | undefined): KiteChain {
  switch ((name ?? "testnet").trim()) {
    case "":
    case "testnet":
    case "sandbox":
      return KITE_TESTNET;
    case "mainnet":
    case "live":
      return KITE_MAINNET;
    default:
      throw new Error(`unknown KITE_NETWORK "${name}" (want testnet or mainnet)`);
  }
}

/**
 * Lets routes be priced as "$0.05" on a Kite network. The x402 SDK only knows
 * default stablecoins for a fixed set of chains; this parser adds Kite and
 * pins the EIP-712 domain the facilitator expects.
 */
export function kiteMoneyParser(chain: KiteChain): MoneyParser {
  return async (amount: string | number, network: Network): Promise<AssetAmount | null> => {
    if (network !== chain.network) return null;
    const text =
      typeof amount === "number"
        ? amount.toFixed(chain.assetDecimals)
        : amount.trim().replace(/^\$/, "");
    if (!/^\d+(\.\d+)?$/.test(text) || Number(text) <= 0) {
      throw new Error(`price must be a positive decimal, got ${amount}`);
    }
    const [whole, frac = ""] = text.split(".");
    if (frac.length > chain.assetDecimals) {
      throw new Error(`price ${text} has more than ${chain.assetDecimals} decimals (${chain.assetSymbol})`);
    }
    const units = BigInt(whole + frac.padEnd(chain.assetDecimals, "0"));
    if (units <= 0n) throw new Error(`price ${amount} is below one unit of ${chain.assetSymbol}`);
    return {
      asset: chain.assetAddress,
      amount: units.toString(),
      extra: { name: chain.eip712Name, version: chain.eip712Version },
    };
  };
}

/** Convert a human USD decimal string into atomic units without floats. */
export function toAtomic(amountUsd: number | string, decimals: number): bigint {
  // String(0.05) is "0.05"; toFixed(18) would expose float noise.
  const text = typeof amountUsd === "number" ? String(amountUsd) : amountUsd.trim();
  if (!/^\d+(\.\d+)?$/.test(text)) throw new Error(`invalid amount: ${amountUsd}`);
  const [whole, frac = ""] = text.split(".");
  if (frac.length > decimals) throw new Error(`amount ${text} has too many decimals`);
  return BigInt(whole + frac.padEnd(decimals, "0"));
}

export function fromAtomic(units: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const whole = units / base;
  const frac = (units % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

export function explorerTxUrl(chain: KiteChain, tx: string | null | undefined): string | null {
  if (!tx || tx.startsWith("mock_")) return null;
  return `${chain.explorerUrl}/tx/${tx}`;
}

const ERC20_ABI = parseAbi([
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

export function walletFromKey(chain: KiteChain, privateKey: Hex) {
  const account = privateKeyToAccount(privateKey);
  const network = {
    id: chain.chainId, name: chain.network,
    nativeCurrency: { name: "KITE", symbol: "KITE", decimals: 18 },
    rpcUrls: { default: { http: [chain.rpcUrl] } },
  };
  const publicClient = createPublicClient({ chain: network, transport: http(chain.rpcUrl) });
  const walletClient = createWalletClient({ account, chain: network, transport: http(chain.rpcUrl) });
  return {
    address: account.address,
    pendingNonce: () => publicClient.getTransactionCount({ address: account.address, blockTag: "pending" }),
    async prepareTransfer(to: Address, atomic: bigint, nonce: number) {
      const request = await walletClient.prepareTransactionRequest({
        account, to: chain.assetAddress,
        data: encodeFunctionData({ abi: ERC20_ABI, functionName: "transfer", args: [to, atomic] }), nonce,
      });
      const rawTransaction = await walletClient.signTransaction(request);
      return { rawTransaction, hash: keccak256(rawTransaction) };
    },
    async confirmTransfer(rawTransaction: Hex, hash: Hex, to: Address, atomic: bigint): Promise<void> {
      let receipt;
      try { receipt = await publicClient.getTransactionReceipt({ hash }); }
      catch (error) { if (!(error instanceof TransactionReceiptNotFoundError)) throw error; }
      if (!receipt) {
        // Retry the identical signed transaction. A timeout/"already known"/nonce
        // error is not permission to create a second transfer.
        try { await walletClient.sendRawTransaction({ serializedTransaction: rawTransaction }); }
        catch { /* Resolve the known hash, including ambiguous broadcast failures. */ }
        receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
      }
      if (receipt.status !== "success") throw new Error(`Transfer reverted: ${hash}; manual reconciliation required`);
      const delivered = receipt.logs.some(log => {
        if (log.address.toLowerCase() !== chain.assetAddress.toLowerCase()) return false;
        try {
          const event = decodeEventLog({ abi: ERC20_ABI, data: log.data, topics: log.topics });
          return event.eventName === "Transfer" && event.args.from.toLowerCase() === account.address.toLowerCase() && event.args.to.toLowerCase() === to.toLowerCase() && event.args.value === atomic;
        } catch { return false; }
      });
      if (!delivered) throw new Error(`Receipt lacks the expected token transfer: ${hash}; manual reconciliation required`);
    },
    balanceOf(address: Address) {
      return publicClient.readContract({ address: chain.assetAddress, abi: ERC20_ABI, functionName: "balanceOf", args: [address] });
    },
  };
}
