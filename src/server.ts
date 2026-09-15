import express from "express";
import cookieParser from "cookie-parser";
import path from "path";
import { fileURLToPath } from "url";
import { config } from "./config.js";
import { webhookRouter } from "./webhook.js";
import { canvasRouter } from "./canvasApi.js";
import { authRouter } from "./authApi.js";
import { sessionFromToken } from "./auth.js";
import { tokenFrom } from "./httpAuth.js";
import { sweepExpiredAuthRows } from "./auth.js";
import { sweepRateLimits } from "./rateLimit.js";
import { backfillUsersFromItems } from "./users.js";
import { resolveMissingSourceProfiles } from "./sourceProfile.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "../public");

const app = express();

// Fly (and any other proxy) puts the real client address in X-Forwarded-For.
// Without this, req.ip is the proxy for every request, and the per-IP rate
// limit collapses into a second global one.
app.set("trust proxy", 1);

app.use(cookieParser());

// Note what is NOT here: express.urlencoded. It is mounted on the webhook
// router alone, because Twilio is the only caller that posts form-encoded.
// An HTML form can only submit urlencoded or multipart, so a JSON-only API is
// not reachable from a cross-site form at all.
app.use("/webhook", webhookRouter);
app.use("/auth", express.json(), authRouter);
app.use("/api", express.json(), canvasRouter);

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
async function serveApp(req: express.Request, res: express.Response): Promise<void> {
  const session = await sessionFromToken(tokenFrom(req));
  if (!session) {
    res.redirect("/login");
    return;
  }
  res.sendFile(path.join(publicDir, "app.html"));
}

app.get("/app", serveApp);
app.get("/app.html", serveApp);

// Already signed in? The login form has nothing to offer - send them to their
// board instead of making them prove who they are twice.
app.get(["/login", "/login.html"], async (req, res) => {
  const session = await sessionFromToken(tokenFrom(req));
  if (session) {
    res.redirect("/app");
    return;
  }
  res.sendFile(path.join(publicDir, "login.html"));
});

// Tidy URL for the privacy policy; the .html spelling still resolves via the
// static handler, so an existing link cannot break.
app.get("/privacy", (_req, res) => {
  res.sendFile(path.join(publicDir, "privacy.html"));
});

// The landing page and every shared asset. `index` is left at its default so
// "/" serves index.html, which is now the public marketing page rather than
// anything that needs a session.
app.use(express.static(publicDir));

const HOUR_MS = 60 * 60 * 1000;

app.listen(config.port, () => {
  console.log(`Whirlpool listening on port ${config.port}`);
  if (config.loginCodeTransport === "console") {
    console.log("Login codes are being printed here, not sent. Set LOGIN_CODE_TRANSPORT=sms to deliver them.");
  }

  // Saves captured before the User table existed have no row to log in as.
  // Idempotent, so it costs one query per boot once it has run.
  backfillUsersFromItems()
    .then((created) => {
      if (created > 0) console.log(`Backfilled ${created} user(s) from existing saves.`);
    })
    .catch((error) => console.error("User backfill failed", error));

  // Deliberately not awaited - the server must accept requests immediately.
  // Once profiles are warm this is one local read per hostname and logs
  // nothing; it exists so a card never stays grey because a capture-time
  // resolution failed, or because it predates the branding feature.
  resolveMissingSourceProfiles()
    .then((resolved) => {
      if (resolved > 0) console.log(`Resolved ${resolved} source profile(s) on startup.`);
    })
    .catch((error) => console.error("Startup source-profile sweep failed", error));

  // Expired codes and sessions, and the rate limiter's in-memory windows.
  // LoginCode gains a row per request by design, so something has to prune it.
  setInterval(() => {
    sweepRateLimits();
    sweepExpiredAuthRows().catch((error) => console.error("Auth sweep failed", error));
  }, HOUR_MS).unref();
});
