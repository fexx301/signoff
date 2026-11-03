import { config, assertLiveConfig } from "./config.js";
import { createApp } from "./server.js";
import { sweep } from "./jobs.js";

const problems = assertLiveConfig();
if (problems.length > 0) {
  console.warn("Signoff starting with missing configuration:");
  for (const problem of problems) console.warn(`  - ${problem}`);
  if (!config.devSkipPayment) {
    console.warn("Set DEV_SKIP_PAYMENT=true for local UI work, or provide the missing secrets.");
  }
}

const app = createApp();

app.listen(config.port, () => {
  console.log(`Signoff on :${config.port} — ${config.publicBaseUrl}`);
  console.log(`  network   ${config.chain.network} (${config.chain.assetSymbol})`);
  console.log(`  payTo     ${config.payTo || "(missing)"}`);
  console.log(`  facilitator ${config.facilitatorUrl}`);
  console.log(`  SERV      ${config.servApiKey ? "live" : "mock"} · seller ${config.dolphinApiKey ? "dolphin" : "fallback"}`);
});

const timer = setInterval(() => {
  void sweep().catch((error) => console.error("sweep failed", error));
}, 10_000);
timer.unref();
