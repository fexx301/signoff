import type { NextFunction, Request, Response } from "express";
import {
  HTTPFacilitatorClient,
  x402HTTPResourceServer,
  x402ResourceServer,
  type HTTPProcessResult,
  type RouteConfig,
} from "@x402/core/server";
import { ExpressAdapter } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { config } from "./config.js";
import { kiteMoneyParser } from "./kite.js";

export type VerifiedPayment = Extract<HTTPProcessResult, { type: "payment-verified" }>;

export interface X402Runtime {
  facilitator: HTTPFacilitatorClient;
  resourceServer: x402ResourceServer;
  httpServer: x402HTTPResourceServer;
  /** Fetches the facilitator's supported kinds; required before verification. */
  initPromise: Promise<void>;
}

/** The buyer may choose the job budget, but only within a demo-safe band. */
export function resolveBudgetUsd(body: unknown): number {
  const raw = (body as { budgetUsd?: unknown } | undefined)?.budgetUsd;
  const parsed = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return config.jobPriceUsd;
  const clamped = Math.min(Math.max(parsed, 0.01), 1);
  return Math.round(clamped * 1e6) / 1e6;
}

export function buildX402(): X402Runtime {
  if (!config.payTo) {
    throw new Error("PAY_TO (or PROCESSOR_PRIVATE_KEY) is required to build the x402 layer");
  }

  const facilitator = new HTTPFacilitatorClient({ url: config.facilitatorUrl });
  const resourceServer = new x402ResourceServer(facilitator).register(
    config.chain.network,
    new ExactEvmScheme().registerMoneyParser(kiteMoneyParser(config.chain)),
  );

  const jobRoute: RouteConfig = {
    resource: `${config.publicBaseUrl}/v1/jobs`,
    accepts: {
      scheme: "exact",
      network: config.chain.network,
      payTo: config.payTo,
      price: (context) => `$${resolveBudgetUsd(context.adapter.getBody?.())}`,
      maxTimeoutSeconds: 300,
    },
    description:
      "Signoff acceptance escrow: the processor holds the payment until an independent verifier confirms the delivered artifact meets the pre-registered criteria.",
    mimeType: "application/json",
    serviceName: "Signoff",
    tags: ["escrow", "acceptance", "verification", "x402"],
    unpaidResponseBody: () => ({
      contentType: "application/json",
      body: {
        error: "payment_required",
        product: "Signoff",
        message:
          "Pay the 402 challenge with a Kite Passport session. Funds are held by the processor and released only after acceptance.",
      },
    }),
  };

  const httpServer = new x402HTTPResourceServer(resourceServer, {
    "POST /v1/jobs": jobRoute,
  });
  const initPromise = httpServer.initialize().catch((error) => {
    console.error("x402 facilitator initialization failed", error);
    throw error;
  });
  // Avoid an unhandled rejection before the first request reaches the gate.
  initPromise.catch(() => undefined);

  return { facilitator, resourceServer, httpServer, initPromise };
}

function sendInstructions(res: Response, instructions: { status: number; headers: Record<string, string>; body?: unknown; isHtml?: boolean }): void {
  res.status(instructions.status);
  for (const [key, value] of Object.entries(instructions.headers)) res.setHeader(key, value);
  if (instructions.isHtml) res.send(instructions.body ?? "");
  else res.json(instructions.body ?? {});
}

/**
 * Manual x402 gate. Unlike the stock middleware, this leaves settlement to the
 * route handler so Signoff can create the job row first and settle only after
 * the row exists. `res.locals.x402` carries the verified payment to the handler.
 */
export function x402Gate(runtime: X402Runtime) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (config.devSkipPayment) {
      res.locals.x402 = null;
      res.locals.devPayment = true;
      next();
      return;
    }

    const adapter = new ExpressAdapter(req);
    const context = {
      adapter,
      path: req.path,
      method: req.method,
      paymentHeader:
        req.header("PAYMENT-SIGNATURE") ?? req.header("X-PAYMENT") ?? req.header("payment-signature"),
    };

    try {
      await runtime.initPromise;
      const result = await runtime.httpServer.processHTTPRequest(context);
      if (result.type === "payment-error") {
        sendInstructions(res, result.response);
        return;
      }
      if (result.type === "no-payment-required") {
        next();
        return;
      }
      res.locals.x402 = result satisfies VerifiedPayment;
      res.locals.x402Context = context;
      next();
    } catch (error) {
      console.error("x402 gate failed", error);
      res.status(502).json({
        error: "payment_verification_failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };
}

export async function settleVerifiedPayment(
  runtime: X402Runtime,
  payment: VerifiedPayment,
  context: Parameters<typeof runtime.httpServer.processSettlement>[3],
): Promise<{ ok: true; transaction: string | null; payer: string | null; headers: Record<string, string> } | { ok: false; error: string }> {
  const result = await runtime.httpServer.processSettlement(
    payment.paymentPayload,
    payment.paymentRequirements,
    payment.declaredExtensions,
    context,
  );

  if (!result.success) {
    return { ok: false, error: result.errorMessage ?? result.errorReason ?? "settlement_failed" };
  }

  return {
    ok: true,
    transaction: result.transaction || null,
    payer: result.payer ?? null,
    headers: result.headers,
  };
}
