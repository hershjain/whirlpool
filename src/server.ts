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

// The canvas. Both spellings are handled, and both ahead of express.static:
// the static handler serves whatever file matches the path, so /index.html
// would walk straight around a gate mounted only on "/". `index: false` below
// covers the directory-index case; this covers the explicit one.
//
// The markup itself is not secret - every byte of data arrives over /api,
// which is gated independently. This is so that a signed-out visitor lands on
// the login page instead of an empty board that silently bounces them.
async function serveCanvas(req: express.Request, res: express.Response): Promise<void> {
  const session = await sessionFromToken(tokenFrom(req));
  if (!session) {
    res.redirect("/login");
    return;
  }
  res.sendFile(path.join(publicDir, "index.html"));
}

app.get("/", serveCanvas);
app.get("/index.html", serveCanvas);

app.get("/login", (_req, res) => {
  res.sendFile(path.join(publicDir, "login.html"));
});

// The login page's own assets, and the canvas's. index: false stops a request
// for "/" being answered from disk before the gate above ever runs.
app.use(express.static(publicDir, { index: false }));

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
