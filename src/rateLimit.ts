// Sliding-window counters for the login endpoints, one row per allowed hit.
//
// These lived in a module-level Map until the move to Postgres. In memory the
// windows reset on every deploy, which handed everyone a fresh allowance - and
// that included the global daily ceiling on login codes, which exists to cap an
// SMS-pumping bill rather than to be fair. A limit whose whole job is to stop
// sustained abuse should not be resettable by shipping a change.
//
// Two queries per check rather than a Map lookup. At this scale that is noise,
// and both are served by the [key, createdAt] index.

import { prisma } from "./db.js";

interface Window {
  windowMs: number;
  max: number;
}

// Called on a timer from the server. Without it the table grows by one row per
// allowed request forever.
export async function sweepRateLimits(): Promise<void> {
  // The longest window any caller uses; anything older cannot affect a
  // decision no matter which bucket it belongs to.
  const maxWindowMs = 24 * 60 * 60 * 1000;
  await prisma.rateLimitHit.deleteMany({
    where: { createdAt: { lt: new Date(Date.now() - maxWindowMs) } },
  });
}

// True when the hit is allowed, false when it is over the limit. Records the
// hit only when allowing it, so a blocked caller cannot push their own window
// further out by hammering it.
//
// Count-then-insert is not atomic, so two simultaneous requests can both see
// the last slot free and both take it. That was equally true of the Map this
// replaces, and the overshoot is one request per concurrent burst against
// limits whose purpose is to stop sustained abuse - not worth a transaction and
// the lock contention that comes with it.
async function take(key: string, { windowMs, max }: Window): Promise<boolean> {
  const since = new Date(Date.now() - windowMs);

  const used = await prisma.rateLimitHit.count({ where: { key, createdAt: { gte: since } } });
  if (used >= max) return false;

  await prisma.rateLimitHit.create({ data: { key } });
  return true;
}

// Sequential rather than Promise.all, preserving the short-circuit the `&&`
// chain used to give: once a bucket refuses, the later ones are never consumed.
async function takeAll(windows: Array<[string, Window]>): Promise<boolean> {
  for (const [key, window] of windows) {
    if (!(await take(key, window))) return false;
  }
  return true;
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// Every limit a code request has to clear. The first is the one a real person
// ever meets - it is the "wait a minute before resending" rule, and the login
// page shows it as a countdown rather than letting them discover it.
export async function allowCodeRequest(
  phone: string,
  ip: string,
  dailyGlobalMax: number,
): Promise<boolean> {
  return takeAll([
    [`code:phone:min:${phone}`, { windowMs: MINUTE, max: 1 }],
    [`code:phone:hour:${phone}`, { windowMs: HOUR, max: 5 }],
    [`code:phone:day:${phone}`, { windowMs: DAY, max: 10 }],
    [`code:ip:hour:${ip}`, { windowMs: HOUR, max: 10 }],
    ["code:global:day", { windowMs: DAY, max: dailyGlobalMax }],
  ]);
}

// Separate from the per-code attempt counter in auth.ts, which dies with its
// code. This one survives across codes, so requesting a fresh code does not
// also buy a fresh set of guesses.
export async function allowVerifyAttempt(phone: string, ip: string): Promise<boolean> {
  return takeAll([
    [`verify:phone:hour:${phone}`, { windowMs: HOUR, max: 10 }],
    [`verify:ip:hour:${ip}`, { windowMs: HOUR, max: 20 }],
  ]);
}

// The Anthropic-spend equivalent of the login-code ceiling. Inbound volume was
// unmetered: nothing stopped one number texting in a loop and running up a model
// bill. Applied to every path that reaches a model - a save, a question, a
// digest - rather than saves alone, because a question is the more expensive of
// the two (up to four calls, with search results folded back into each prompt).
//
// The free commands (list, search, help, STOP) never reach here; they are
// database reads and cost nothing to serve.
export async function allowModelRequest(phone: string, dailyMax: number): Promise<boolean> {
  return take(`model:phone:day:${phone}`, { windowMs: DAY, max: dailyMax });
}
