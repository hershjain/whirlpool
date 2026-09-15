import { Router, type Request } from "express";
import { prisma } from "./db.js";
import { config } from "./config.js";
import { toE164, isDeliverable } from "./phone.js";
import { createLoginCode, verifyLoginCode, createSession, revokeSession } from "./auth.js";
import { deliverLoginCode } from "./notify.js";
import { allowCodeRequest, allowVerifyAttempt } from "./rateLimit.js";
import { setSessionCookie, clearSessionCookie, tokenFrom, rejectCrossSite } from "./httpAuth.js";

export const authRouter: Router = Router();

authRouter.use(rejectCrossSite);

function clientIp(req: Request): string {
  // Meaningful only because server.ts sets `trust proxy`. Without it every
  // request behind Fly's proxy reports the same address and the per-IP limit
  // silently becomes a global one.
  return req.ip ?? "unknown";
}

// POST /auth/request-code  { phone }
//
// Always 204, whatever happens: unknown number, opted out, rate limited,
// unparseable, delivery failure. Any response that distinguishes those turns
// this endpoint into an oracle for "does this person use Whirlpool", which is
// a real privacy leak for a product whose whole content is what someone reads.
//
// The work happens after the response for the same reason - a lookup and an
// SMS take long enough that the difference would be measurable. This mirrors
// what webhook.ts already does for Twilio's benefit.
authRouter.post("/request-code", (req, res) => {
  res.status(204).end();

  const phone = toE164((req.body as { phone?: unknown })?.phone as string | undefined);
  const ip = clientIp(req);

  void (async () => {
    try {
      if (!phone) {
        console.log("[login] request-code with an unparseable number");
        return;
      }
      if (!isDeliverable(phone)) {
        console.log(`[login] refused ${phone}: outside the allowed calling codes`);
        return;
      }
      if (!allowCodeRequest(phone, ip, config.maxDailyLoginCodes)) {
        console.log(`[login] rate limited ${phone} from ${ip}`);
        return;
      }

      const user = await prisma.user.findUnique({ where: { phone } });
      if (!user) {
        // The intended path for someone who has not texted in yet. The login
        // page already tells them that is the prerequisite.
        console.log(`[login] no account for ${phone}`);
        return;
      }
      if (user.optedOutAt) {
        console.log(`[login] ${phone} has opted out; not sending`);
        return;
      }

      const code = await createLoginCode(phone);
      await deliverLoginCode(phone, code);
    } catch (error) {
      console.error("[login] failed to issue a code", error);
    }
  })();
});

// POST /auth/verify  { phone, code }
//
// One generic failure for every reason. Telling the difference between wrong,
// expired and out-of-attempts is exactly the feedback that makes guessing
// cheaper, and none of it helps a real user do anything different.
authRouter.post("/verify", async (req, res) => {
  const body = req.body as { phone?: unknown; code?: unknown };
  const phone = toE164(body?.phone as string | undefined);
  const code = typeof body?.code === "string" ? body.code.trim() : "";

  const failure = { error: "That code isn't right, or it has expired. Request a new one." };

  if (!phone || !/^\d{6}$/.test(code)) {
    res.status(400).json(failure);
    return;
  }

  if (!allowVerifyAttempt(phone, clientIp(req))) {
    res.status(429).json({ error: "Too many attempts. Try again later." });
    return;
  }

  if (!(await verifyLoginCode(phone, code))) {
    res.status(400).json(failure);
    return;
  }

  const token = await createSession(phone);
  setSessionCookie(res, token);
  res.status(204).end();
});

// --- DEV-LOGIN: local development only, remove before launch ---
//
// GET reports whether the bypass exists, so the login page can show its button
// only when it will work. POST mints a session for OWNER_PHONE_NUMBER with no
// code at all. Both 404 under NODE_ENV=production, which is the same stance
// config.ts takes on console-transport codes: a dev shortcut that survives
// into production is an authentication bypass, so it is wired shut there
// rather than left to a checklist.
authRouter.get("/dev-login", (_req, res) => {
  res.json({ enabled: config.devLogin });
});

authRouter.post("/dev-login", async (_req, res) => {
  if (!config.devLogin) {
    res.status(404).end();
    return;
  }

  const phone = toE164(config.ownerPhoneNumber);
  if (!phone) {
    res.status(500).json({ error: "OWNER_PHONE_NUMBER is not a valid E.164 number" });
    return;
  }

  // Session has a foreign key to User, so the row has to exist. optInAt
  // defaults and optInMessageSid is nullable, so there is no fake consent
  // record here - this user simply has no opt-in message, which is true.
  await prisma.user.upsert({
    where: { phone },
    update: { lastSeenAt: new Date() },
    create: { phone },
  });

  const token = await createSession(phone);
  setSessionCookie(res, token);
  console.log(`[dev-login] signed in as ${phone} with no code`);
  res.status(204).end();
});

authRouter.post("/logout", async (req, res) => {
  await revokeSession(tokenFrom(req));
  clearSessionCookie(res);
  res.status(204).end();
});
