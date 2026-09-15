import crypto from "crypto";
import { prisma } from "./db.js";

// --- Tunables ---

const CODE_LENGTH = 6;
const CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
// Six digits is a million combinations, which is only strong because guessing
// stops. Five tries against a live code is generous for a typo and useless
// for a search.
const MAX_CODE_ATTEMPTS = 5;

// A hard ceiling, independent of the cookie. The cookie below is a session
// cookie and normally dies when the browser quits, but "restore tabs" can
// carry one across a restart on Chrome and Safari, so the server does not
// rely on that: the row is dead at 24 hours whatever the client kept.
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
// Writing lastSeenAt on every request would be a database write per API call
// for a field nothing reads at that resolution.
const SESSION_TOUCH_INTERVAL_MS = 60 * 60 * 1000;

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

// --- Login codes ---

// Math.random is a predictable PRNG - given a few outputs its internal state
// is recoverable, and every future code with it. randomInt draws from the
// same CSPRNG as key generation.
function generateCode(): string {
  return crypto.randomInt(0, 10 ** CODE_LENGTH).toString().padStart(CODE_LENGTH, "0");
}

// Mints a code for `phone` and returns it in the clear exactly once, to be
// handed straight to delivery. Only its hash is persisted: a leaked database
// must not be a pile of working login codes.
//
// Any code already outstanding for this number is consumed first, so
// requesting a second code invalidates the first. Without that, every resend
// widens the set of currently-valid codes.
export async function createLoginCode(phone: string): Promise<string> {
  const code = generateCode();

  await prisma.$transaction([
    prisma.loginCode.updateMany({
      where: { phone, consumedAt: null },
      data: { consumedAt: new Date() },
    }),
    prisma.loginCode.create({
      data: {
        phone,
        codeHash: sha256(code),
        expiresAt: new Date(Date.now() + CODE_TTL_MS),
      },
    }),
  ]);

  return code;
}

// Deliberately collapses every failure into `false`. The caller must not be
// able to tell a wrong code from an expired one from a burnt-out one, because
// whatever it can tell, so can someone guessing.
export async function verifyLoginCode(phone: string, code: string): Promise<boolean> {
  const record = await prisma.loginCode.findFirst({
    where: { phone, consumedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
  });

  if (!record) return false;

  if (record.attempts >= MAX_CODE_ATTEMPTS) {
    // Burn it rather than leave a dead row that keeps being found and
    // re-counted on every subsequent guess.
    await prisma.loginCode.update({
      where: { id: record.id },
      data: { consumedAt: new Date() },
    });
    return false;
  }

  // Counted before the comparison, so a crash or a disconnect mid-verify
  // cannot be used to take a free guess.
  await prisma.loginCode.update({
    where: { id: record.id },
    data: { attempts: { increment: 1 } },
  });

  const submitted = Buffer.from(sha256(code.trim()));
  const expected = Buffer.from(record.codeHash);
  // Both are 64-char hex digests, so the lengths always match; the guard is
  // for timingSafeEqual's own contract, which throws otherwise.
  const matches = submitted.length === expected.length && crypto.timingSafeEqual(submitted, expected);

  if (!matches) return false;

  await prisma.loginCode.update({
    where: { id: record.id },
    data: { consumedAt: new Date() },
  });
  return true;
}

// --- Sessions ---

export interface SessionUser {
  phone: string;
  sessionId: string;
}

// Returns the raw token for the cookie. As with codes, only the hash is
// stored, so read access to the table does not confer the ability to
// impersonate anyone holding a session.
export async function createSession(phone: string): Promise<string> {
  const token = crypto.randomBytes(32).toString("base64url");

  await prisma.session.create({
    data: {
      tokenHash: sha256(token),
      phone,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    },
  });

  return token;
}

export async function sessionFromToken(token: string | undefined): Promise<SessionUser | null> {
  if (!token) return null;

  const session = await prisma.session.findUnique({ where: { tokenHash: sha256(token) } });
  if (!session || session.revokedAt || session.expiresAt <= new Date()) return null;

  if (Date.now() - session.lastSeenAt.getTime() > SESSION_TOUCH_INTERVAL_MS) {
    await prisma.session.update({
      where: { id: session.id },
      data: { lastSeenAt: new Date() },
    });
  }

  return { phone: session.phone, sessionId: session.id };
}

export async function revokeSession(token: string | undefined): Promise<void> {
  if (!token) return;
  // updateMany, not update: logging out twice, or with a stale cookie, is a
  // normal thing for a browser to do and must not throw.
  await prisma.session.updateMany({
    where: { tokenHash: sha256(token), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

// --- Housekeeping ---

// Expired codes and sessions carry no value once past their date, and
// LoginCode keeps one row per request by design. Called on a timer from the
// server so the tables do not grow without bound.
export async function sweepExpiredAuthRows(): Promise<void> {
  const now = new Date();
  await prisma.loginCode.deleteMany({ where: { expiresAt: { lt: now } } });
  await prisma.session.deleteMany({ where: { expiresAt: { lt: now } } });
}
