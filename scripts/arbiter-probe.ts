// Probe: does Kite's dev Coordination Runtime accept a proposal naming a non-Engine arbiter?
// Sends a buyer-signed, unfunded `proposal` (no money moves). Usage: tsx scripts/arbiter-probe.ts <arbiterDid>
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { keccak256, toBytes, concat, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { execFileSync } from "node:child_process";

const BASE = "https://passport.dev.gokite.ai";
const EXT = "https://a2a.gokite.ai/extensions/coordination-workflow/v1";
const MEDIA = "application/vnd.gokite.agreement-command+json;version=1";
const SELLER = process.env.PROBE_SELLER ?? "did:kite:ind-spring-zhang-seller1:escrow-haiku-seller";
const BUYER = "did:kite:ind-signoff:probe-buyer";
const arbiter = process.argv[2] ?? "did:kite:ind-signoff:arbiter";

// RFC 8785 for the value shapes used here (strings, integers, booleans, null, arrays, objects).
export function jcs(v: unknown): string {
  if (v === null || typeof v !== "object") {
    if (typeof v === "number" && !Number.isInteger(v)) throw new Error("non-integer number");
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map(jcs).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${jcs(o[k])}`).join(",")}}`;
}
const sha = (s: string) => "sha256:" + createHash("sha256").update(s, "utf8").digest("hex");

const off = JSON.parse(
  execFileSync("kpass", ["agent", "directory", "offering", SELLER, process.env.PROBE_OFFERING ?? "haiku-standard", "--output", "json", "--no-interactive"], {
    env: { ...process.env, KITE_PASSPORT_BASE_URL: BASE },
  }).toString(),
).offering;
const offering = off.offering;
const config = off.workflow.config;
const templateId: string = off.workflow.template.id;
const chartHash: string = off.workflow.template.chartHash;
const workflow = { workflowHash: off.workflow.workflowHash, templateId, chartHash, config, configHash: sha(jcs(config)) };
if (workflow.configHash !== off.workflow.configHash) throw new Error("configHash does not reproduce (JCS mismatch)");
if (sha(jcs({ templateId, chartHash, config })) !== workflow.workflowHash) throw new Error("workflowHash does not reproduce");

const card = await (await fetch(`${BASE}/.well-known/agent-card.json`)).json();
const engine = "did:kite:corp-kite:kite-coordination-engine";

const key = readFileSync(".kite-passport/keys/probe-buyer.key", "utf8").trim();
const acct = privateKeyToAccount((key.startsWith("0x") ? key : `0x${key}`) as Hex);
const thumb = execFileSync("kpass", ["agent", "key", "show", "--key-file", ".kite-passport/keys/probe-buyer.key", "--no-interactive"], {
  env: { ...process.env, KITE_PASSPORT_BASE_URL: BASE },
}).toString().match(/jkt:[0-9a-f]+/)![0];

const contract: Record<string, unknown> = {
  schema: "urn:kiteai:coordination:schema:deal-contract:v1",
  workflow,
  buyerAgentId: BUYER,
  sellerAgentId: SELLER,
  registrationBasis: { registrationHash: offering.registrationHash, offeringId: offering.offeringId },
  deliverable: offering.title,
  acceptanceCriteria: offering.workflowTerms.acceptanceMarkdown,
  price: { amount: "1", asset: "USDC" },
  escrow: { payoutAddress: offering.payoutAddress, refundAddress: acct.address },
  disputePolicy: { arbiterAgentId: arbiter },
  runtimeBinding: { runtimeAgentId: engine, agentCardHash: sha(jcs(card)), extensionUri: EXT, endpoint: card.supportedInterfaces[0].url },
};
const termsHash = sha(jcs({ chartHash, terms: jcs(contract) }));
const digest = keccak256(concat([toBytes("kite:a2a-agreement:terms:v1"), toBytes(termsHash)]));
const sig = await acct.sign({ hash: digest });
contract.signatures = [{ signerAgentId: BUYER, profile: "secp256k1-keccak-v1", keyId: `${BUYER}#${thumb}`, sig }];

const body = {
  jsonrpc: "2.0", id: randomBytes(6).toString("hex"), method: "SendMessage",
  params: { message: { messageId: randomBytes(8).toString("hex"), role: "ROLE_USER", extensions: [EXT],
    parts: [{ raw: Buffer.from(jcs({ kind: "proposal", contract, ...(process.env.PROBE_TOP_CHART ? { chartHash } : {}) })).toString("base64"), mediaType: MEDIA }] } },
};
const res = await fetch(card.supportedInterfaces[0].url, {
  method: "POST", headers: { "content-type": "application/json", "A2A-Extensions": EXT, "A2A-Version": "1.0" }, body: JSON.stringify(body),
});
const text = await res.text();
let out = text;
try {
  const j = JSON.parse(text);
  for (const p of j?.result?.message?.parts ?? j?.result?.task?.status?.message?.parts ?? []) {
    if (p.raw) p.decoded = JSON.parse(Buffer.from(p.raw, "base64").toString("utf8"));
  }
  out = JSON.stringify(j, null, 1);
} catch {}
console.log(JSON.stringify({ arbiter, buyerAddress: acct.address, termsHash, http: res.status }));
console.log(out.slice(0, 4000));
