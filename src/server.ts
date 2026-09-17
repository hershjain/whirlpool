import express from "express";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import path from "path";
import { fileURLToPath } from "url";
import { config } from "./config.js";
import { prisma } from "./db.js";
import { webhookRouter } from "./webhook.js";
import { canvasRouter } from "./canvasApi.js";
import { authRouter } from "./authApi.js";
import { sessionFromToken } from "./auth.js";
import { tokenFrom } from "./httpAuth.js";
import { sweepExpiredAuthRows } from "./auth.js";
import { sweepRateLimits } from "./rateLimit.js";
import { backfillUsersFromItems } from "./users.js";
import { resolveMissingSourceProfiles } from "./sourceProfile.js";
import { asyncHandler, errorMiddleware, notFoundJson, installProcessHandlers } from "./http.js";
import { log, httpLogger, initSentry, reportError } from "./logger.js";
import { inFlightJobs } from "./jobs.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "../public");

initSentry();

const app = express();

// Fly (and any other proxy) puts the real client address in X-Forwarded-For.
// Without this, req.ip is the proxy for every request, and the per-IP rate
// limit collapses into a second global one.
app.set("trust proxy", 1);
app.disable("x-powered-by");

// One structured line per request, carrying an id that every later line about
// that request repeats. Mounted first so it also covers responses produced by
// middleware below it.
app.use(httpLogger);

// www -> apex. PUBLIC_BASE_URL is one origin and httpAuth.ts compares the
// Origin header against it by exact string, so a visitor who typed the www
// hostname would get a page that renders and then 403s on every write. The
// alternative - allowing both origins - means two hostnames setting session
// cookies independently, so canonicalising is the cheaper fix.
//
// Deliberately narrow: only the exact www form of the canonical host is
// caught. A blanket "hostname is not canonical" rule would also catch Fly's
// health check and the .fly.dev hostname, and a machine that fails its health
// check fails the deploy.
//
// Needs `fly certs add www.<domain>` and the matching DNS record, or the TLS
// handshake fails before this ever runs.
// .hostname, not .host: req.hostname below has the port stripped, so comparing
// against a value that keeps it never matches on any origin carrying one.
const canonicalHost = new URL(config.publicBaseUrl).hostname;
const wwwHost = `www.${canonicalHost}`;

app.use((req, res, next) => {
  if (req.hostname !== wwwHost) {
    next();
    return;
  }
  // 308 for anything that might carry a body: a 301 permits the client to
  // re-issue a POST as GET, which would turn a save into a page load and lose
  // it silently.
  const status = req.method === "GET" || req.method === "HEAD" ? 301 : 308;
  res.redirect(status, `${config.publicBaseUrl}${req.originalUrl}`);
});

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // The canvas and the landing page both carry inline <style> blocks and
        // a little inline script; unsafe-inline is what keeps them working.
        // Worth tightening to a nonce later - noted rather than pretended away.
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        // Card hero images are hotlinked from wherever the article lives, so
        // this genuinely cannot be narrowed without also storing the bytes.
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        // Off locally, where the origin is plain http and upgrading every
        // subresource to https would break the page it is meant to protect.
        upgradeInsecureRequests: config.isProduction ? [] : null,
      },
    },
    // Fly terminates TLS and force_https redirects, so HSTS is safe to assert.
    hsts: config.isProduction ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    crossOriginEmbedderPolicy: false,
  }),
);

app.use(cookieParser());

// Liveness *and* readiness. A check that only proves the process is listening
// would stay green on a machine whose database is unreachable, which is the
// state where staying in the load balancer is worst: every request 500s.
// Declared before express.static so it can never be shadowed by a file.
app.get(
  "/healthz",
  asyncHandler(async (_req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({ ok: true });
    } catch (error) {
      reportError(error, { scope: "healthz" });
      res.status(503).json({ ok: false });
    }
  }),
);

// Note what is NOT here: express.urlencoded. It is mounted on the webhook
// router alone, because Twilio is the only caller that posts form-encoded.
// An HTML form can only submit urlencoded or multipart, so a JSON-only API is
// not reachable from a cross-site form at all.
//
// The explicit limit replaces Express's implicit 100kb default - same number,
// but stated rather than inherited.
app.use("/webhook", webhookRouter);
app.use("/auth", express.json({ limit: "100kb" }), authRouter);
app.use("/api", express.json({ limit: "100kb" }), canvasRouter);

// One origin serves all three faces of the product: the landing page at "/",
// the login form at "/login", and the canvas at "/app". They used to be two
// deploys, which forced login onto the app's origin anyway - a cookie set by
// the API cannot be read from another origin without SameSite=None, which
// browsers are steadily switching off. Collapsing them means relative links
// work everywhere with nothing to configure, and there is no second domain to
// keep alive or forget to point at.
//
// Every route below is declared ahead of express.static, because the static
// handler answers whatever path matches a file on disk: "/app.html" would walk
// straight around a gate mounted only on "/app".

// The canvas. Its markup is not secret - every byte of data arrives over /api,
// which is gated independently - but a signed-out visitor should land on the
// login page rather than an empty board that silently bounces them.
const serveApp = asyncHandler(async (req: express.Request, res: express.Response) => {
  const session = await sessionFromToken(tokenFrom(req));
  if (!session) {
    res.redirect("/login");
    return;
  }
  res.sendFile(path.join(publicDir, "app.html"));
});

app.get("/app", serveApp);
app.get("/app.html", serveApp);

// Already signed in? The login form has nothing to offer - send them to their
// board instead of making them prove who they are twice.
app.get(
  ["/login", "/login.html"],
  asyncHandler(async (req, res) => {
    const session = await sessionFromToken(tokenFrom(req));
    if (session) {
      res.redirect("/app");
      return;
    }
    res.sendFile(path.join(publicDir, "login.html"));
  }),
);

// Tidy URLs for the two policy pages; the .html spelling still resolves via
// the static handler, so an existing link cannot break. Both are linked from
// the landing page's carrier disclosure because A2P campaign review looks for
// them there, so the paths are effectively part of the filing - don't rename
// them without updating the campaign.
app.get("/privacy", (_req, res) => {
  res.sendFile(path.join(publicDir, "privacy.html"));
});

app.get("/terms", (_req, res) => {
  res.sendFile(path.join(publicDir, "terms.html"));
});

// The landing page and every shared asset. `index` is left at its default so
// "/" serves index.html, which is now the public marketing page rather than
// anything that needs a session.
//
// maxAge is deliberately short rather than long: nothing here is fingerprinted,
// so a long cache would mean a deploy takes a week to reach an open tab. Five
// minutes keeps the revalidation traffic down without that.
app.use(express.static(publicDir, { maxAge: config.isProduction ? "5m" : 0 }));

// An unmatched /api path would otherwise fall through to the static handler and
// then to Express's HTML 404, which a fetch() caller tries to parse as JSON.
app.use("/api", notFoundJson);
app.use("/auth", notFoundJson);

// Last, after every route: anything a handler threw or rejected with lands here.
app.use(errorMiddleware);

const HOUR_MS = 60 * 60 * 1000;

const server = app.listen(config.port, () => {
  log.info(
    {
      port: config.port,
      env: config.isProduction ? "production" : "development",
      transport: config.loginCodeTransport,
      devLogin: config.devLogin,
      sentry: Boolean(config.sentryDsn),
    },
    "Whirlpool listening",
  );

  if (config.loginCodeTransport === "console") {
    log.warn("Login codes are being printed here, not sent. Set LOGIN_CODE_TRANSPORT=sms to deliver them.");
  }
  if (config.devLogin) {
    // Stated plainly and at warn level, in the first few lines of the log, so a
    // deployment that came up as development is something you notice on the
    // first boot rather than discover later.
    log.warn("DEV-LOGIN IS ENABLED - /auth/dev-login will mint a session with no code. Never in production.");
  }

  // Saves captured before the User table existed have no row to log in as.
  // Idempotent, so it costs one query per boot once it has run.
  backfillUsersFromItems()
    .then((created) => {
      if (created > 0) log.info({ created }, "Backfilled users from existing saves.");
    })
    .catch((error) => reportError(error, { scope: "startup.backfillUsers" }));

  // Deliberately not awaited - the server must accept requests immediately.
  // Once profiles are warm this is one local read per hostname and logs
  // nothing; it exists so a card never stays grey because a capture-time
  // resolution failed, or because it predates the branding feature.
  resolveMissingSourceProfiles()
    .then((resolved) => {
      if (resolved > 0) log.info({ resolved }, "Resolved source profiles on startup.");
    })
    .catch((error) => reportError(error, { scope: "startup.sourceProfiles" }));

  // Expired codes and sessions, and the rate limiter's spent windows.
  // LoginCode gains a row per request by design, so something has to prune it.
  setInterval(() => {
    sweepRateLimits().catch((error) => reportError(error, { scope: "sweep.rateLimits" }));
    sweepExpiredAuthRows().catch((error) => reportError(error, { scope: "sweep.auth" }));
  }, HOUR_MS).unref();
});

// Fly sends SIGTERM on every deploy. Without a handler the process is killed
// mid-request, and - worse - mid-capture: the webhook acks Twilio immediately
// and does the fetching and enrichment afterwards, so a hard kill loses work
// that the sender has no way of knowing failed.
let shuttingDown = false;

async function shutdown(code: number, signal?: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal, code }, "Shutting down");

  // Stop taking new work first, so the drain below is finite.
  server.close();

  try {
    await inFlightJobs.drain(25_000);
  } catch (error) {
    reportError(error, { scope: "shutdown.drain" });
  }

  try {
    await prisma.$disconnect();
  } catch (error) {
    reportError(error, { scope: "shutdown.disconnect" });
  }

  process.exit(code);
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => void shutdown(0, signal));
}

installProcessHandlers((code) => void shutdown(code));
