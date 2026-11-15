/**
 * AI usage tracking and the per-user daily allowance. Every Studio request that calls the AI goes
 * through withAiAllowance(): it refuses once today's allowance is used up, then records the tokens
 * the call actually consumed. Requests still running count against the allowance too, so firing
 * several at once can't slip past it.
 *
 * Allowance: AI_DAILY_LIMIT requests per user per UTC day (default 40; 0 turns the limit off).
 * Superusers are never limited. A request that failed before the AI answered used no tokens and
 * isn't counted.
 */
import { and, eq, gte } from "drizzle-orm";
import { db } from "../db/connection.js";
import { aiUsage, users, type UserRow } from "../db/schema.js";
import { HttpError } from "./authService.js";
import type { UsageEntry } from "./aiService.js";

// $ per 1,000,000 tokens. Priced at read time from the stored model name, so history stays right if
// these change. An unknown model is priced as the default one.
export const PRICING: Record<string, { input: number; output: number }> = {
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4o": { input: 2.5, output: 10.0 },
  // Price cut shortly after its July 2026 launch (from $1/$6 to this) — re-check before trusting
  // this for a long-lived cost report if it's been a while since this was last verified.
  "gpt-5.6-luna": { input: 0.2, output: 1.2 },
};
const DEFAULT_PRICING = PRICING["gpt-5.6-luna"];

export function costUsd(model: string | null | undefined, promptTokens: number, completionTokens: number): number {
  const rates = (model && PRICING[model]) || DEFAULT_PRICING;
  return (promptTokens / 1_000_000) * rates.input + (completionTokens / 1_000_000) * rates.output;
}

export function dailyLimit(): number {
  const raw = Number(process.env.AI_DAILY_LIMIT ?? 40);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

// null = unlimited.
export function limitFor(user: Pick<UserRow, "isSuperuser">): number | null {
  const limit = dailyLimit();
  return user.isSuperuser || limit === 0 ? null : limit;
}

export function startOfUtcDay(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export function nextUtcMidnight(now = new Date()): Date {
  return new Date(startOfUtcDay(now).getTime() + 24 * 3600 * 1000);
}

function resetsIn(now = new Date()): string {
  const minutes = Math.max(1, Math.ceil((nextUtcMidnight(now).getTime() - now.getTime()) / 60000));
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

const inFlight = new Map<number, number>();

async function requestsSince(userId: number, since: Date): Promise<number> {
  const rows = await db.select({ id: aiUsage.id }).from(aiUsage).where(and(eq(aiUsage.userId, userId), gte(aiUsage.createdAt, since)));
  return rows.length;
}

export async function checkAllowance(user: Pick<UserRow, "id" | "isSuperuser">, now = new Date()): Promise<void> {
  const limit = limitFor(user);
  if (limit === null) return;
  const used = (await requestsSince(user.id, startOfUtcDay(now))) + (inFlight.get(user.id) ?? 0);
  if (used >= limit) {
    throw new HttpError(429, `You've used all ${limit} AI requests for today. Your allowance resets in about ${resetsIn(now)}.`);
  }
}

export async function recordAiUsage(userId: number, kind: string, applicationId: number | null, sink: UsageEntry[]): Promise<void> {
  if (sink.length === 0) return;
  await db.insert(aiUsage).values({
    userId, kind, applicationId,
    model: sink[sink.length - 1].model,
    promptTokens: sink.reduce((s, u) => s + u.prompt_tokens, 0),
    completionTokens: sink.reduce((s, u) => s + u.completion_tokens, 0),
    totalTokens: sink.reduce((s, u) => s + u.total_tokens, 0),
  });
}

export async function withAiAllowance<T>(
  user: Pick<UserRow, "id" | "isSuperuser">, kind: string, applicationId: number | null, run: (sink: UsageEntry[]) => Promise<T>
): Promise<T> {
  await checkAllowance(user);
  inFlight.set(user.id, (inFlight.get(user.id) ?? 0) + 1);
  const sink: UsageEntry[] = [];
  try {
    return await run(sink);
  } finally {
    const left = (inFlight.get(user.id) ?? 1) - 1;
    if (left > 0) inFlight.set(user.id, left); else inFlight.delete(user.id);
    // Tokens spent count even when the request then failed on our side.
    await recordAiUsage(user.id, kind, applicationId, sink).catch((e) => console.error("Couldn't record AI usage:", e));
  }
}

type UsageRow = { kind: string; model: string | null; promptTokens: number; completionTokens: number; totalTokens: number; createdAt: Date | null };
type Totals = { requests: number; tokens: number; costUsd: number };

const round = (n: number) => Math.round(n * 10000) / 10000;
function add(t: Totals, r: UsageRow) {
  t.requests += 1;
  t.tokens += r.totalTokens;
  t.costUsd += costUsd(r.model, r.promptTokens, r.completionTokens);
}
const empty = (): Totals => ({ requests: 0, tokens: 0, costUsd: 0 });
const rounded = (t: Totals): Totals => ({ ...t, costUsd: round(t.costUsd) });

// Today, the last 14 days day by day, and the last 30 days by kind of request.
export function summarize(rows: UsageRow[], now = new Date()) {
  const todayStart = startOfUtcDay(now).getTime();
  const today = empty();
  const month = empty();
  const days = new Map<string, Totals>();
  for (let i = 13; i >= 0; i--) days.set(new Date(todayStart - i * 86400000).toISOString().slice(0, 10), empty());
  const kinds = new Map<string, Totals>();
  for (const r of rows) {
    const at = r.createdAt ? new Date(r.createdAt) : now;
    add(month, r);
    if (at.getTime() >= todayStart) add(today, r);
    const day = days.get(at.toISOString().slice(0, 10));
    if (day) add(day, r);
    if (!kinds.has(r.kind)) kinds.set(r.kind, empty());
    add(kinds.get(r.kind)!, r);
  }
  return {
    today: rounded(today),
    last30Days: rounded(month),
    days: [...days].map(([date, t]) => ({ date, ...rounded(t) })),
    byKind: [...kinds].map(([kind, t]) => ({ kind, ...rounded(t) })).sort((a, b) => b.requests - a.requests),
  };
}

const since30 = (now: Date) => new Date(startOfUtcDay(now).getTime() - 29 * 86400000);

export async function usageFor(user: Pick<UserRow, "id" | "isSuperuser">, now = new Date()) {
  const rows = await db.select().from(aiUsage).where(and(eq(aiUsage.userId, user.id), gte(aiUsage.createdAt, since30(now))));
  const summary = summarize(rows, now);
  const limit = limitFor(user);
  return {
    limit,
    usedToday: summary.today.requests,
    remaining: limit === null ? null : Math.max(0, limit - summary.today.requests),
    resetsAt: nextUtcMidnight(now).toISOString(),
    ...summary,
  };
}

// Every user's usage over the last 30 days, heaviest first — for the admin view.
export async function usageForEveryone(now = new Date()) {
  const rows = await db
    .select({
      userId: aiUsage.userId, email: users.email, fullName: users.fullName, isSuperuser: users.isSuperuser,
      kind: aiUsage.kind, model: aiUsage.model, promptTokens: aiUsage.promptTokens, completionTokens: aiUsage.completionTokens,
      totalTokens: aiUsage.totalTokens, createdAt: aiUsage.createdAt,
    })
    .from(aiUsage)
    .innerJoin(users, eq(users.id, aiUsage.userId))
    .where(gte(aiUsage.createdAt, since30(now)));
  const byUser = new Map<number, { email: string; fullName: string | null; isSuperuser: boolean; rows: UsageRow[] }>();
  for (const r of rows) {
    if (!byUser.has(r.userId)) byUser.set(r.userId, { email: r.email, fullName: r.fullName, isSuperuser: !!r.isSuperuser, rows: [] });
    byUser.get(r.userId)!.rows.push(r);
  }
  const usersOut = [...byUser].map(([userId, u]) => {
    const s = summarize(u.rows, now);
    return { userId, email: u.email, fullName: u.fullName, limit: limitFor(u), today: s.today, last30Days: s.last30Days };
  }).sort((a, b) => b.last30Days.costUsd - a.last30Days.costUsd);
  const all = summarize(rows, now);
  return { dailyLimit: dailyLimit() || null, today: all.today, last30Days: all.last30Days, days: all.days, users: usersOut };
}
