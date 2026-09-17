import { Router, type Request, type Response } from "express";
import express from "express";
import { prisma } from "./db.js";
import { isValidTwilioRequest, sendSms } from "./twilio.js";
import { handleInboundMessage } from "./commands.js";
import { config } from "./config.js";
import { toE164 } from "./phone.js";
import { upsertUserOnInbound } from "./users.js";
import { sendWelcome } from "./notify.js";
import { inFlightJobs } from "./jobs.js";
import { log, safePhone, reportError } from "./logger.js";

export const webhookRouter: Router = Router();

// Twilio posts form-encoded, and only Twilio does. Scoped to this router
// rather than mounted on the app, so the JSON API cannot be reached by a
// cross-site HTML form - a form can only send urlencoded or multipart bodies,
// so an API that parses neither is not a CSRF target in the first place.
webhookRouter.use(express.urlencoded({ extended: false, limit: "100kb" }));

// How long a claim can sit in "processing" before it is treated as abandoned.
// Longer than any real capture - a page fetch plus two model calls is seconds,
// not minutes - and short enough that a Twilio retry after a crash still lands
// inside the window it retries in.
const CLAIM_STALE_MS = 5 * 60 * 1000;

webhookRouter.post("/sms", (req: Request, res: Response) => {
  const signature = req.header("X-Twilio-Signature");
  const url = `${config.publicBaseUrl}/webhook/sms`;

  if (!isValidTwilioRequest(signature, url, req.body)) {
    log.warn({ url }, "Rejected webhook with an invalid Twilio signature");
    res.status(403).send("Invalid signature");
    return;
  }

  // Ack immediately - Twilio retries on slow responses (~15s), and a slow
  // LLM/fetch call here would otherwise trigger duplicate delivery.
  res.type("text/xml").send("<Response></Response>");

  const from = req.body.From as string | undefined;
  const body = (req.body.Body as string | undefined) ?? "";
  const messageSid = req.body.MessageSid as string | undefined;

  if (!from || !messageSid) return;

  // Everything downstream keys off this string, so it has to be the same
  // spelling the login form will produce for the same human. Twilio sends
  // E.164 already; normalizing anyway means there is exactly one place where
  // a phone number becomes a tenant key.
  const phone = toE164(from);
  if (!phone) {
    log.error({ from: safePhone(from) }, "Inbound from an unparseable number");
    return;
  }

  // Tracked rather than simply detached, so a deploy drains it instead of
  // killing it halfway.
  void inFlightJobs.run(() => processInBackground(phone, body, messageSid));
});

// Claims the message for processing, or reports that someone else already has.
//
// The old version created this row and treated any duplicate-key error as "seen
// this, skip it" - which was right for a Twilio retry and badly wrong for a
// crash. The row was written *before* the work, so a deploy mid-capture left a
// claim that looked finished: Twilio's retry hit it, returned, and the message
// was gone with no error anywhere. A claim is now only conclusive once it is
// marked completed; one left mid-flight past CLAIM_STALE_MS can be taken over.
async function claimMessage(messageSid: string): Promise<boolean> {
  try {
    await prisma.processedMessage.create({ data: { messageSid } });
    return true;
  } catch {
    // Row exists. Whether that means "done" or "abandoned" decides it.
  }

  const existing = await prisma.processedMessage.findUnique({ where: { messageSid } });
  if (!existing || existing.status === "completed") return false;

  const age = Date.now() - existing.claimedAt.getTime();
  if (age < CLAIM_STALE_MS) return false; // genuinely in flight elsewhere

  // Re-claim, but only if nobody else beat us to it in the meantime - the
  // conditional updateMany is what makes this safe without a transaction.
  const taken = await prisma.processedMessage.updateMany({
    where: { messageSid, status: "processing", claimedAt: existing.claimedAt },
    data: { claimedAt: new Date() },
  });
  if (taken.count === 0) return false;

  log.warn({ messageSid, ageMs: age }, "Re-claiming an abandoned message");
  return true;
}

async function processInBackground(phone: string, body: string, messageSid: string): Promise<void> {
  if (!(await claimMessage(messageSid))) return;

  try {
    // Before anything else: the User row has to exist for a first-time texter
    // or their item has no owner to log in as. This is the account creation -
    // there is no sign-up form anywhere in the product.
    const { created } = await upsertUserOnInbound(phone, messageSid);

    const reply = await handleInboundMessage(phone, body, messageSid);

    if (created) {
      // Capture is silent by design, but the first message has nothing to
      // confirm it worked and no pointer at the webview. Sent after the
      // handler so a failed save reports the failure instead.
      await sendWelcome(phone).catch((error) =>
        reportError(error, { scope: "welcome", phone: safePhone(phone) }),
      );
    }

    if (reply) {
      await sendSms(phone, reply);
    }

    await prisma.processedMessage.update({
      where: { messageSid },
      data: { status: "completed", completedAt: new Date() },
    });

    log.info({ messageSid, phone: safePhone(phone), replied: Boolean(reply) }, "Processed inbound message");
  } catch (error) {
    reportError(error, { scope: "inbound", messageSid, phone: safePhone(phone) });

    // Left as "processing" on purpose: a retry from Twilio, or the stale-claim
    // path above, can pick it up rather than the message being lost for good.
    await sendSms(phone, "Something went wrong processing that — try again in a bit.").catch(
      (sendError) => reportError(sendError, { scope: "inbound.errorReply", messageSid }),
    );
  }
}
