import twilio from "twilio";
import { config } from "./config.js";
import { log, safePhone } from "./logger.js";

export const twilioClient = twilio(config.twilioAccountSid, config.twilioAuthToken);

// Twilio rejects a body over 1600 characters outright, and bills every 160-char
// segment below that. A chat answer is capped at 1024 output tokens, which is
// roughly 4,000 characters - about 26 segments, or a hard failure. The prompts
// ask for brevity, but a prompt is a request and this is a limit.
const MAX_SMS_LENGTH = 1500;

function truncateForSms(body: string): string {
  if (body.length <= MAX_SMS_LENGTH) return body;

  // Cut at a word boundary where there is one nearby, so the message ends
  // mid-sentence rather than mid-word.
  const head = body.slice(0, MAX_SMS_LENGTH - 1);
  const lastSpace = head.lastIndexOf(" ");
  const cut = lastSpace > MAX_SMS_LENGTH - 200 ? head.slice(0, lastSpace) : head;
  return `${cut}…`;
}

export async function sendSms(to: string, body: string): Promise<void> {
  const text = truncateForSms(body);
  if (text.length < body.length) {
    log.warn(
      { phone: safePhone(to), original: body.length, sent: text.length },
      "Truncated an outbound message to fit SMS limits",
    );
  }

  await twilioClient.messages.create({
    from: config.twilioPhoneNumber,
    to,
    body: text,
  });
}

export function isValidTwilioRequest(
  signature: string | undefined,
  url: string,
  params: Record<string, unknown>,
): boolean {
  if (!signature) return false;
  return twilio.validateRequest(config.twilioAuthToken, signature, url, params);
}
