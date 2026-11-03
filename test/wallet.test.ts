import { beforeEach, expect, it, vi } from "vitest";
const rpc = vi.hoisted(() => ({ receipt: vi.fn(), wait: vi.fn(), broadcast: vi.fn(), prepare: vi.fn(), sign: vi.fn() }));
vi.mock("viem", async original => {
  const actual = await original<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: () => ({ getTransactionReceipt: rpc.receipt, waitForTransactionReceipt: rpc.wait }),
    createWalletClient: () => ({ sendRawTransaction: rpc.broadcast, prepareTransactionRequest: rpc.prepare, signTransaction: rpc.sign }),
  };
});
import { encodeEventTopics, encodeAbiParameters, parseAbi, TransactionReceiptNotFoundError, keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { KITE_TESTNET, walletFromKey } from "../src/kite.js";
const key = `0x${"11".repeat(32)}` as const;
const sender = privateKeyToAccount(key).address;
const to = "0x2222222222222222222222222222222222222222";
const raw = "0x1234";
const hash = keccak256(raw);
const abi = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);
const success = { status: "success", logs: [{ address: KITE_TESTNET.assetAddress, topics: encodeEventTopics({ abi, eventName: "Transfer", args: { from: sender, to } }), data: encodeAbiParameters([{type:"uint256"}], [50n]) }] };
beforeEach(() => { Object.values(rpc).forEach(mock => mock.mockReset()); });
it("does not broadcast an already confirmed transfer", async () => {
  rpc.receipt.mockResolvedValue(success);
  await walletFromKey(KITE_TESTNET, key).confirmTransfer(raw, hash, to, 50n);
  expect(rpc.broadcast).not.toHaveBeenCalled();
});
it("resolves the same transaction after an ambiguous broadcast error", async () => {
  rpc.receipt.mockRejectedValue(new TransactionReceiptNotFoundError({ hash }));
  rpc.broadcast.mockRejectedValue(new Error("Already known")); rpc.wait.mockResolvedValue(success);
  await walletFromKey(KITE_TESTNET, key).confirmTransfer(raw, hash, to, 50n);
  expect(rpc.broadcast).toHaveBeenCalledWith({ serializedTransaction: raw });
  expect(rpc.wait).toHaveBeenCalledWith({ hash, timeout: 60_000 });
});
it("does not treat a submitted hash as a confirmed transfer", async () => {
  rpc.receipt.mockRejectedValue(new TransactionReceiptNotFoundError({ hash }));
  rpc.broadcast.mockResolvedValue(hash); rpc.wait.mockRejectedValue(new Error("Receipt timeout"));
  await expect(walletFromKey(KITE_TESTNET, key).confirmTransfer(raw, hash, to, 50n)).rejects.toThrow("Receipt timeout");
});
it("rejects reverted and successful receipts without the token transfer", async () => {
  rpc.receipt.mockResolvedValueOnce({ status: "reverted", logs: [] });
  await expect(walletFromKey(KITE_TESTNET, key).confirmTransfer(raw, hash, to, 50n)).rejects.toThrow("reverted");
  rpc.receipt.mockResolvedValueOnce({ status: "success", logs: [] });
  await expect(walletFromKey(KITE_TESTNET, key).confirmTransfer(raw, hash, to, 50n)).rejects.toThrow("expected token transfer");
});
it("binds a prepared transfer to the reserved nonce and signed hash", async () => {
  rpc.prepare.mockImplementation(async req => req); rpc.sign.mockResolvedValue(raw);
  const result = await walletFromKey(KITE_TESTNET, key).prepareTransfer(to, 50n, 7);
  expect(rpc.prepare.mock.calls[0]![0]).toMatchObject({ nonce: 7, to: KITE_TESTNET.assetAddress });
  expect(result).toEqual({ rawTransaction: raw, hash }); expect(rpc.broadcast).not.toHaveBeenCalled();
});
