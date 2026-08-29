import { Router, type Request, type Response } from "express";
import { prisma } from "./db.js";
import { isValidTwilioRequest, sendSms } from "./twilio.js";
import { handleInboundMessage } from "./commands.js";
import { config } from "./config.js";

export const webhookRouter: Router = Router();

function normalizePhone(phone: string): string {
  return phone.replace(/[^\d+]/g, "");
}

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

  if (normalizePhone(from) !== normalizePhone(config.ownerPhoneNumber)) {
    return; // not our number - ignore silently
  }

  processInBackground(from, body, messageSid);
});

async function processInBackground(from: string, body: string, messageSid: string): Promise<void> {
  try {
    await prisma.processedMessage.create({ data: { messageSid } });
  } catch {
    return; // already processed this message (Twilio retry) - skip
  }

  try {
    const reply = await handleInboundMessage(from, body, messageSid);
    await sendSms(from, reply);
  } catch (error) {
    console.error("Failed to process inbound message", messageSid, error);
    await sendSms(from, "Something went wrong processing that — try again in a bit.").catch(() => {});
  }
}
