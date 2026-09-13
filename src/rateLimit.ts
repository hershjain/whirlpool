// Sliding-window counters for the login endpoints.
//
// In-memory on purpose. This is a single-process server on one Fly machine
// backed by one SQLite file, so a shared store would be ceremony around a Map.
// The tradeoff is real and worth naming: the windows reset on deploy, so a
// restart hands everyone a fresh allowance. That is acceptable for limits
// whose job is to stop sustained abuse and cap a bill, not to enforce a quota
// to the message. Move this to the database if the server is ever replicated,
// or the per-IP limit silently becomes per-IP-per-instance.

interface Window {
  windowMs: number;
  max: number;
}

const hits = new Map<string, number[]>();

// Called on a timer from the server. Without it, every phone number and IP
// that ever touched the endpoint stays in the Map for the life of the process.
export function sweepRateLimits(): void {
  const now = Date.now();
  // The longest window any caller uses; anything older cannot affect a
  // decision no matter which bucket it belongs to.
  const maxWindowMs = 24 * 60 * 60 * 1000;

  for (const [key, timestamps] of hits) {
    const live = timestamps.filter((t) => now - t < maxWindowMs);
    if (live.length === 0) hits.delete(key);
    else hits.set(key, live);
  }
}

// True when the hit is allowed, false when it is over the limit. Records the
// hit only when allowing it, so a blocked caller cannot push their own window
// further out by hammering it.
function take(key: string, { windowMs, max }: Window): boolean {
  const now = Date.now();
  const timestamps = (hits.get(key) ?? []).filter((t) => now - t < windowMs);

  if (timestamps.length >= max) {
    hits.set(key, timestamps);
    return false;
  }

  timestamps.push(now);
  hits.set(key, timestamps);
  return true;
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// Every limit a code request has to clear. The first is the one a real person
// ever meets - it is the "wait a minute before resending" rule, and the login
// page shows it as a countdown rather than letting them discover it.
export function allowCodeRequest(phone: string, ip: string, dailyGlobalMax: number): boolean {
  return (
    take(`code:phone:min:${phone}`, { windowMs: MINUTE, max: 1 }) &&
    take(`code:phone:hour:${phone}`, { windowMs: HOUR, max: 5 }) &&
    take(`code:phone:day:${phone}`, { windowMs: DAY, max: 10 }) &&
    take(`code:ip:hour:${ip}`, { windowMs: HOUR, max: 10 }) &&
    take("code:global:day", { windowMs: DAY, max: dailyGlobalMax })
  );
}

// Separate from the per-code attempt counter in auth.ts, which dies with its
// code. This one survives across codes, so requesting a fresh code does not
// also buy a fresh set of guesses.
export function allowVerifyAttempt(phone: string, ip: string): boolean {
  return (
    take(`verify:phone:hour:${phone}`, { windowMs: HOUR, max: 10 }) &&
    take(`verify:ip:hour:${ip}`, { windowMs: HOUR, max: 20 })
  );
}
