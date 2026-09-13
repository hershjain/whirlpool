import { Router, type Request, type Response } from "express";
import express from "express";
import { prisma } from "./db.js";
import { isValidTwilioRequest, sendSms } from "./twilio.js";
import { handleInboundMessage } from "./commands.js";
import { config } from "./config.js";
import { toE164 } from "./phone.js";
import { upsertUserOnInbound } from "./users.js";
import { sendWelcome } from "./notify.js";

export const webhookRouter: Router = Router();

// Twilio posts form-encoded, and only Twilio does. Scoped to this router
// rather than mounted on the app, so the JSON API cannot be reached by a
// cross-site HTML form - a form can only send urlencoded or multipart bodies,
// so an API that parses neither is not a CSRF target in the first place.
webhookRouter.use(express.urlencoded({ extended: false }));

webhookRouter.post("/sms", (req: Request, res: Response) => {
  const signature = req.header("X-Twilio-Signature");
  const url = `${config.publicBaseUrl}/webhook/sms`;

  if (!isValidTwilioRequest(signature, url, req.body)) {
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
    console.error(`Inbound from an unparseable number: ${from}`);
    return;
  }

  processInBackground(phone, body, messageSid);
});

async function processInBackground(phone: string, body: string, messageSid: string): Promise<void> {
  try {
    await prisma.processedMessage.create({ data: { messageSid } });
  } catch {
    return; // already processed this message (Twilio retry) - skip
  }

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
      await sendWelcome(phone).catch((error) => console.error("Welcome message failed", error));
    }

    if (reply) {
      await sendSms(phone, reply);
    }
  } catch (error) {
    console.error("Failed to process inbound message", messageSid, error);
    await sendSms(phone, "Something went wrong processing that — try again in a bit.").catch(() => {});
  }
}
