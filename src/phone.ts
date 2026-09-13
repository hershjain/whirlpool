import parsePhoneNumberFromString from "libphonenumber-js";

// The one place a phone number becomes a tenant key.
//
// The old normalizer stripped non-digits and stopped there, which made
// "4155551234" and "+14155551234" two different people: the webhook stores
// whatever Twilio's E.164 `From` says, while a login form gets whatever the
// user felt like typing. Every save would land under one spelling and every
// login under the other, and the canvas would come up empty with nothing
// visibly wrong. Both sides call this instead.
//
// Returns null rather than throwing - an unparseable number is an ordinary
// outcome on a public form, not an exception.
export function toE164(input: string | null | undefined): string | null {
  if (!input) return null;

  // Default region only applies when the input carries no "+" prefix, so a
  // number already in E.164 keeps its own country code.
  const parsed = parsePhoneNumberFromString(input.trim(), "US");
  if (!parsed || !parsed.isValid()) return null;

  return parsed.number;
}

// Countries we will send a login code to. Anything else is refused before a
// message is ever billed.
//
// This is the cheapest control against SMS pumping - the fraud where someone
// drives thousands of code requests at premium-rate ranges they earn a cut
// of, and the bill lands on you. The product is US/Canada only today, so the
// allowlist costs nothing and closes the whole category. Widen it
// deliberately, one calling code at a time.
const ALLOWED_CALLING_CODES = new Set(["1"]);

export function isDeliverable(e164: string): boolean {
  const parsed = parsePhoneNumberFromString(e164);
  if (!parsed) return false;
  return ALLOWED_CALLING_CODES.has(parsed.countryCallingCode.toString());
}

// "+14155551234" -> "(•••) •••-1234". Shown in the webview chrome so someone
// on a shared machine can tell whose board they are looking at, without
// printing a full number onto the screen.
export function maskPhone(e164: string): string {
  const last4 = e164.slice(-4);
  return `(•••) •••-${last4}`;
}
