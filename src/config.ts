import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  }
  return parsed;
}

const isProduction = process.env.NODE_ENV === "production";

// How a login code reaches the user. "console" prints it to the server log
// and sends nothing, which is what lets the whole login flow be built and
// tested while Twilio A2P registration is still pending.
const transport = process.env.LOGIN_CODE_TRANSPORT === "sms" ? "sms" : "console";

// A dev transport that shipped by accident would be an authentication bypass:
// anyone able to read the logs could log in as anyone. Refuse to boot rather
// than trust a deploy checklist. The override exists for a staging box that
// deliberately runs with NODE_ENV=production and no sender.
if (isProduction && transport === "console" && process.env.ALLOW_CONSOLE_CODES !== "1") {
  throw new Error(
    "LOGIN_CODE_TRANSPORT=console in production would print login codes to the log " +
      "instead of sending them. Set LOGIN_CODE_TRANSPORT=sms, or ALLOW_CONSOLE_CODES=1 " +
      "if this environment really is not public.",
  );
}

export const config = {
  twilioAccountSid: required("TWILIO_ACCOUNT_SID"),
  twilioAuthToken: required("TWILIO_AUTH_TOKEN"),
  twilioPhoneNumber: required("TWILIO_PHONE_NUMBER"),
  // Retained only to seed the first User row on an existing install. Nothing
  // else reads it any more: the webhook accepts every number, and the API is
  // scoped by session.
  ownerPhoneNumber: required("OWNER_PHONE_NUMBER"),
  publicBaseUrl: required("PUBLIC_BASE_URL"),
  anthropicApiKey: required("ANTHROPIC_API_KEY"),
  port: Number(process.env.PORT ?? 3000),

  isProduction,

  // DEV-LOGIN: a one-click way past the login flow while A2P registration is
  // pending. Tied to NODE_ENV rather than a variable of its own, so there is
  // no value you can set that turns this on in production - and nothing to
  // remember on deploy day. The four pieces are all tagged DEV-LOGIN and come
  // out together: this flag, the /auth/dev-login routes, the button in
  // public/login.html, and the reveal in public/login.js.
  devLogin: !isProduction,

  loginCodeTransport: transport as "sms" | "console",

  // Ceiling on codes sent per calendar day across every user. Not a fairness
  // control - the per-phone and per-IP limits do that - but the backstop that
  // caps the bill if an attacker finds a way around both.
  maxDailyLoginCodes: intFromEnv("MAX_DAILY_LOGIN_CODES", 200),
};
