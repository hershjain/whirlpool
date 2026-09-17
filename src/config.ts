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

const publicBaseUrl = required("PUBLIC_BASE_URL");

// PUBLIC_BASE_URL has to be a bare origin. Twilio signature validation
// reconstructs the webhook URL from it by string concatenation (webhook.ts), and
// the Origin allowlist compares it by exact string (httpAuth.ts) - so a trailing
// slash does not degrade anything, it silently 403s every inbound message and
// every write from the canvas. Fail at boot instead, where it is one line in the
// log rather than a week of "why do my texts not save".
{
  let parsed: URL;
  try {
    parsed = new URL(publicBaseUrl);
  } catch {
    throw new Error(`PUBLIC_BASE_URL is not a valid URL: "${publicBaseUrl}"`);
  }
  if (parsed.origin !== publicBaseUrl) {
    throw new Error(
      `PUBLIC_BASE_URL must be a bare origin with no path, query or trailing ` +
        `slash. Got "${publicBaseUrl}", expected "${parsed.origin}".`,
    );
  }
}

// The whole prod/dev split hangs on NODE_ENV: it gates the dev-login bypass, the
// Secure flag on the session cookie, and the login-code transport guard below.
// Nothing warns you when it is unset - the app just quietly runs as development
// on a public hostname, with an unauthenticated /auth/dev-login answering the
// internet. So infer the one case we can detect and refuse: an https origin is
// not a laptop.
if (!isProduction && publicBaseUrl.startsWith("https://")) {
  throw new Error(
    `PUBLIC_BASE_URL is "${publicBaseUrl}" but NODE_ENV is ` +
      `"${process.env.NODE_ENV ?? "unset"}". An https origin means this is a real ` +
      `deployment, and running it as development would leave the dev-login ` +
      `bypass enabled and the session cookie without Secure. Set ` +
      `NODE_ENV=production.`,
  );
}

// How a login code reaches the user. "console" prints it to the server log and
// sends nothing, which is what lets the whole login flow be built and tested
// while Twilio A2P registration is still pending.
//
// Validated against the exact set rather than defaulting anything that is not
// "sms" to console: a typo used to mean codes were silently logged instead of
// sent, with the app looking like it worked.
const rawTransport = process.env.LOGIN_CODE_TRANSPORT ?? "console";
if (rawTransport !== "sms" && rawTransport !== "console") {
  throw new Error(
    `LOGIN_CODE_TRANSPORT must be "sms" or "console", got "${rawTransport}".`,
  );
}
const transport: "sms" | "console" = rawTransport;

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
  // Still required only because DEV-LOGIN below still exists - it is the number
  // that bypass signs in as. Nothing else reads it: the webhook accepts every
  // number, and the API is scoped by session. It comes out when DEV-LOGIN does.
  ownerPhoneNumber: required("OWNER_PHONE_NUMBER"),
  publicBaseUrl,
  anthropicApiKey: required("ANTHROPIC_API_KEY"),

  // Read by Prisma, not by this module - but required here so a missing value
  // fails at boot with a clear message instead of on the first query, which
  // reaches the user as a 500 and the log as a connection error.
  databaseUrl: required("DATABASE_URL"),

  // Optional. With no DSN the Sentry calls are no-ops, so local development and
  // CI need no account.
  sentryDsn: process.env.SENTRY_DSN ?? null,

  // Through intFromEnv rather than a bare Number(): PORT=abc used to yield NaN,
  // which makes Node bind a random free port and puts "http://localhost:NaN"
  // into the Origin allowlist.
  port: intFromEnv("PORT", 3000),

  isProduction,

  // DEV-LOGIN: a one-click way past the login flow while A2P registration is
  // pending. Tied to NODE_ENV rather than a variable of its own, so there is
  // no value you can set that turns this on in production - and nothing to
  // remember on deploy day. The four pieces are all tagged DEV-LOGIN and come
  // out together: this flag, the /auth/dev-login routes, the button in
  // public/login.html, and the reveal in public/login.js.
  //
  // Kept deliberately for now. Note that it makes NODE_ENV load-bearing, which
  // is why the assertion above refuses to boot as development on an https
  // origin - that check is the thing standing between this and the internet.
  devLogin: !isProduction,

  loginCodeTransport: transport,

  // Ceiling on codes sent per calendar day across every user. Not a fairness
  // control - the per-phone and per-IP limits do that - but the backstop that
  // caps the bill if an attacker finds a way around both.
  maxDailyLoginCodes: intFromEnv("MAX_DAILY_LOGIN_CODES", 200),

  // Ceiling on how many times one number can reach a model per day - saves,
  // questions and digests alike. Nothing metered that before; this is the same
  // shape of backstop as maxDailyLoginCodes, for the Anthropic bill rather than
  // the Twilio one. The free commands (list, search, help) do not count.
  maxDailyModelRequestsPerPhone: intFromEnv("MAX_DAILY_MODEL_REQUESTS_PER_PHONE", 200),
};
