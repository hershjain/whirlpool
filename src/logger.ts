import { randomUUID } from "crypto";
import type { IncomingMessage, ServerResponse } from "http";
import pino from "pino";
// Named import, not default: pino-http ships CJS with an ESM-shaped .d.ts, so
// under NodeNext the default resolves to the module namespace rather than the
// callable.
import { pinoHttp, type HttpLogger } from "pino-http";
import * as Sentry from "@sentry/node";
import type { Request, Response } from "express";
import { config } from "./config.js";
import { maskPhone } from "./phone.js";

// Structured logs, one JSON object per line, which is what Fly's log shipper
// and every drain downstream of it expect. Pretty-printing is left off
// deliberately even in development: the shape you debug against should be the
// shape you get in production.
export const log: pino.Logger = pino({
  level: process.env.LOG_LEVEL ?? (config.isProduction ? "info" : "debug"),
  base: undefined, // no pid/hostname - one process, and Fly already labels it
  redact: {
    // A backstop, not the primary control. The primary control is that call
    // sites pass `phone: safePhone(...)`; this catches the ones that forget,
    // and anything a library puts in the object for us.
    paths: [
      "req.headers.cookie",
      "req.headers.authorization",
      "res.headers['set-cookie']",
      "code",
      "token",
      "*.code",
      "*.token",
    ],
    censor: "[redacted]",
  },
});

// A phone number is the whole identity here, so a log line carrying one is a
// log line carrying a person. Every call site that used to interpolate a raw
// E.164 goes through this instead; what lands is enough to correlate two lines
// about the same user and not enough to text them.
export function safePhone(e164: string | null | undefined): string {
  if (!e164) return "(none)";
  return maskPhone(e164);
}

// Per-request logging with an id threaded onto every line the request produces.
// Without it a failure in a background job and the request that started it are
// two unrelated lines a few hundred entries apart.
export const httpLogger: HttpLogger = pinoHttp({
  logger: log,
  genReqId: (req: IncomingMessage, res: ServerResponse) => {
    const existing = req.headers["fly-request-id"];
    const id = (Array.isArray(existing) ? existing[0] : existing) ?? randomUUID();
    res.setHeader("X-Request-Id", id);
    return id;
  },
  // The webhook and the health check are the two highest-volume paths and the
  // least interesting when they succeed. Failures still log at warn/error.
  autoLogging: {
    ignore: (req: IncomingMessage) => req.url === "/healthz",
  },
  customLogLevel: (_req: IncomingMessage, res: ServerResponse, err?: Error) => {
    if (err || res.statusCode >= 500) return "error";
    if (res.statusCode >= 400) return "warn";
    return "info";
  },
  serializers: {
    req: (req: Request) => ({ id: req.id, method: req.method, url: req.url }),
    res: (res: Response) => ({ statusCode: res.statusCode }),
  },
});

// Sentry is what makes an error something you find out about rather than
// something you grep for later. Optional: with no DSN every call below is a
// no-op, so local development and CI do not need an account.
export function initSentry(): void {
  if (!config.sentryDsn) {
    log.info("SENTRY_DSN is not set - errors will be logged but not reported.");
    return;
  }
  Sentry.init({
    dsn: config.sentryDsn,
    environment: config.isProduction ? "production" : "development",
    // Errors only. Traces would be the interesting next step, but they cost
    // quota and there is nothing here yet that a log line does not explain.
    tracesSampleRate: 0,
  });
}

export function reportError(error: unknown, context: Record<string, unknown> = {}): void {
  log.error({ err: error, ...context }, "Unhandled error");
  if (config.sentryDsn) {
    Sentry.captureException(error, { extra: context });
  }
}
