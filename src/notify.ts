import { config } from "./config.js";
import { sendSms } from "./twilio.js";

// The seam between "a code exists" and "the user has it".
//
// US carriers drop messages from unregistered long codes, so until A2P
// registration clears, nothing sent from the Twilio number arrives. Routing
// delivery through one function means the entire login flow can be written,
// exercised and reviewed now, with codes printed to the server log, and
// switched to real SMS by changing one environment variable.
//
// The rule that keeps this from being a backdoor: the code is never returned
// in an HTTP response, in either mode. It goes to the phone or to the log,
// and the log is not something an attacker on the internet can read.
// config.ts additionally refuses to boot in console mode under NODE_ENV=production.

function codeMessage(code: string): string {
  // The trailing "@domain #code" line is the domain-bound one-time-code
  // format iOS reads to offer the code above the keyboard. The domain has to
  // match the origin serving the login page or the offer does not appear.
  const domain = new URL(config.publicBaseUrl).host;

  return [
    `Your Whirlpool login code is ${code}. It expires in 10 minutes.`,
    "",
    `@${domain} #${code}`,
  ].join("\n");
}

export async function deliverLoginCode(phone: string, code: string): Promise<void> {
  if (config.loginCodeTransport === "console") {
    console.log(`[login] code for ${phone}: ${code}`);
    return;
  }

  await sendSms(phone, codeMessage(code));
}

// Sent once, on the message that creates an account.
//
// Silent capture is a deliberate product rule, but on the very first text it
// is indistinguishable from a number that does not work - there is nothing to
// tell the user their save landed or that an account now exists. This is the
// one exception. It also carries the STOP disclosure that carriers expect on
// the first message of a conversation.
export async function sendWelcome(phone: string): Promise<void> {
  const body = [
    "Saved. This is Whirlpool — text me links or thoughts and I'll keep them, quietly.",
    "",
    `See everything you've saved at ${config.publicBaseUrl}/login`,
    "",
    'Text "help" for commands. Reply STOP to opt out.',
  ].join("\n");

  if (config.loginCodeTransport === "console") {
    console.log(`[welcome] would send to ${phone}:\n${body}`);
    return;
  }

  await sendSms(phone, body);
}
