/** Generates a dedicated TESTNET key locally. Prints the public address only. */
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { parse } from "dotenv";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const path = resolve(".env.local");
const original = existsSync(path) ? readFileSync(path, "utf8") : "";
const env = parse(original);
if (env.KITE_NETWORK && !["testnet", "sandbox"].includes(env.KITE_NETWORK)) throw new Error("Processor setup is testnet-only");
const seller = process.argv.includes("--seller");
const key = (seller ? env.SELLER_PRIVATE_KEY : env.PROCESSOR_PRIVATE_KEY) || generatePrivateKey();
const account = privateKeyToAccount(key as `0x${string}`);
let updated = original;
for (const [name, value] of Object.entries({ KITE_NETWORK: "testnet", SELLER_SECRET: env.SELLER_SECRET || randomBytes(32).toString("hex"), ...(seller ? { SELLER_PRIVATE_KEY: key, SELLER_PAYOUT_ADDRESS: account.address } : { PROCESSOR_PRIVATE_KEY: key, PAY_TO: account.address }) })) {
  const line = new RegExp(`^${name}=.*$`, "m");
  updated = line.test(updated) ? updated.replace(line, `${name}=${value}`) : `${updated.trimEnd()}\n${name}=${value}\n`;
}
// Keep existing keys, SERV credentials, and development switches. The file is
// ignored by Git; the temporary replacement is private from creation.
const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
writeFileSync(temporary, updated, { mode: 0o600, flag: "wx" });
if (existsSync(path) && readFileSync(path, "utf8") !== original) throw new Error("Configuration changed during setup; retry without overwriting it");
renameSync(temporary, path);
console.log(`Kite TESTNET ${seller ? "seller" : "processor"} address: ${account.address}`);
console.log("Private key saved locally in ignored .env.local (permissions 600). It was not printed.");
if (!seller) console.log("Request testnet KITE for this address at https://faucet.gokite.ai/");
