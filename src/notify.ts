import { config } from "./config.js";
import { sendSms } from "./twilio.js";
import { log, safePhone } from "./logger.js";

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
    // The code is the entire point of this transport, so it is printed; the
    // number beside it is not. A log line pairing a live code with the phone it
    // opens is a credential, and this transport exists precisely for
    // environments where logs get read casually.
    //
    // It goes in the message rather than a field because logger.ts redacts a
    // "code" key everywhere, so an accidental one never leaks and this
    // deliberate one still reads.
    log.warn({ phone: safePhone(phone) }, `[login] code printed, not sent: ${code}`);
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
// Split out from sendWelcome so the encoding rule below can be asserted in a
// test without a Twilio client.
//
// Every character here is GSM-7, and it has to stay that way. A single
// character outside that alphabet - an em dash, a curly apostrophe, an
// ellipsis - silently re-encodes the whole message as UCS-2, where a segment
// holds 67 characters instead of 153. At this length that is the difference
// between two billed segments and three, on the one message every user gets.
// Nothing about the sent message looks different, which is why it is a test
// rather than a comment on its own.
export function welcomeMessage(): string {
  return [
    "Saved. This is Whirlpool - text me links or thoughts and I'll keep them, quietly.",
    "",
    `See everything you've saved at ${config.publicBaseUrl}/login`,
    "",
    'Text "help" for commands. Reply STOP to opt out.',
  ].join("\n");
}

export async function sendWelcome(phone: string): Promise<void> {
  const body = welcomeMessage();

  if (config.loginCodeTransport === "console") {
    log.info({ phone: safePhone(phone) }, "[welcome] would send (console transport)");
    return;
  }

  await sendSms(phone, body);
}
