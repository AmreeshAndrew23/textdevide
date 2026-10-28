/**
 * In-memory brute-force guard for the per-application login action — keyed on
 * `${applicationId}:${username}` (identity, not IP; credential stuffing targets an account
 * regardless of source address) rather than a general-purpose rate limiter (see server.ts's
 * @fastify/rate-limit registration for that). Known, accepted limitation: this resets on a
 * process restart and isn't shared across multiple instances — fine at this project's current
 * single-instance scale, not worth Redis-backed storage yet.
 */
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;

type Attempt = { count: number; firstAt: number };

const attempts = new Map<string, Attempt>();

function keyOf(applicationId: number, username: string): string {
  return `${applicationId}:${username.toLowerCase()}`;
}

export function isLocked(applicationId: number, username: string): boolean {
  const entry = attempts.get(keyOf(applicationId, username));
  if (!entry) return false;
  if (Date.now() - entry.firstAt > WINDOW_MS) {
    attempts.delete(keyOf(applicationId, username));
    return false;
  }
  return entry.count >= MAX_ATTEMPTS;
}

export function recordFailure(applicationId: number, username: string): void {
  const key = keyOf(applicationId, username);
  const entry = attempts.get(key);
  if (!entry || Date.now() - entry.firstAt > WINDOW_MS) {
    attempts.set(key, { count: 1, firstAt: Date.now() });
  } else {
    entry.count += 1;
  }
}

export function recordSuccess(applicationId: number, username: string): void {
  attempts.delete(keyOf(applicationId, username));
}
