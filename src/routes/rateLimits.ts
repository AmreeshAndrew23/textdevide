/**
 * Per-route limits, tighter than server.ts's blanket 120/minute, for the endpoints worth abusing:
 * anything that checks a password, sends an email, creates accounts or spends AI money. Keyed by
 * client IP (server.ts trusts exactly one proxy hop, so this is the visitor's, not Railway's).
 * Each route gets its own counter. Spread one into the route options: app.post(path, AUTH_LIMIT, handler).
 */
const limit = (max: number, timeWindow: string) => ({ config: { rateLimit: { max, timeWindow } } });

// Studio sign-in and sign-up.
export const AUTH_LIMIT = limit(10, "1 minute");
// Each call costs real money — the daily allowance (services/aiUsage.ts) is the real cap; this
// stops a runaway script from burning a whole day's allowance in seconds.
export const AI_LIMIT = limit(12, "1 minute");
// Bulk writes (CSV import) and anything that emails someone.
export const BULK_LIMIT = limit(10, "1 minute");
export const EMAIL_LIMIT = limit(20, "1 minute");
