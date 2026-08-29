import twilio from "twilio";
import { config } from "./config.js";

export const twilioClient = twilio(config.twilioAccountSid, config.twilioAuthToken);

export async function sendSms(to: string, body: string): Promise<void> {
  await twilioClient.messages.create({
    from: config.twilioPhoneNumber,
    to,
    body,
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
