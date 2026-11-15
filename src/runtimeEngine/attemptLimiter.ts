/**
 * Sliding-window counter for actions that are cheap to request but costly to allow in bulk —
 * creating accounts and sending reset emails from a published app. Keyed by the caller's choice
 * (app + action + IP). In memory, like loginAttemptGuard.ts: resets on restart, fine for one
 * instance.
 */
const hits = new Map<string, number[]>();
let lastSweep = 0;

function sweep(now: number, windowMs: number) {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [key, times] of hits) if (!times.some((t) => now - t < windowMs)) hits.delete(key);
}

// Counts this attempt and says whether it's within the limit. A refused attempt isn't counted,
// so waiting always helps.
export function allowAttempt(key: string, max: number, windowMs: number, now = Date.now()): boolean {
  sweep(now, windowMs);
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= max) {
    hits.set(key, recent);
    return false;
  }
  recent.push(now);
  hits.set(key, recent);
  return true;
}

// Per visitor, per published app.
export const PUBLIC_ACTION_LIMITS: Record<string, { max: number; windowMs: number; message: string }> = {
  register: { max: 5, windowMs: 60 * 60 * 1000, message: "Too many sign-ups from your network. Try again in an hour." },
  requestPasswordReset: { max: 5, windowMs: 15 * 60 * 1000, message: "Too many reset requests. Try again in 15 minutes." },
};
