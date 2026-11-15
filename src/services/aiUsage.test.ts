import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A tiny stand-in for the ai_usage table: select counts rows, insert stores them.
const stored: Record<string, unknown>[] = [];
vi.mock("../db/connection.js", () => {
  const chain = (rows: () => unknown[]) => ({ from: () => ({ where: async () => rows(), innerJoin: () => ({ where: async () => rows() }) }) });
  return {
    db: {
      select: () => chain(() => stored),
      insert: () => ({ values: async (v: Record<string, unknown>) => { stored.push({ ...v, createdAt: new Date() }); } }),
    },
  };
});

const { checkAllowance, costUsd, limitFor, summarize, withAiAllowance, nextUtcMidnight } = await import("./aiUsage.js");

const user = { id: 7, isSuperuser: false };
const sink = (tokens: number) => [{ model: "gpt-5.6-luna", prompt_tokens: tokens, completion_tokens: tokens, total_tokens: tokens * 2 }];

beforeEach(() => { stored.length = 0; process.env.AI_DAILY_LIMIT = "2"; });
afterEach(() => { delete process.env.AI_DAILY_LIMIT; });

describe("the daily AI allowance", () => {
  it("is per user, off for superusers, and off when set to 0", () => {
    expect(limitFor(user)).toBe(2);
    expect(limitFor({ isSuperuser: true })).toBeNull();
    process.env.AI_DAILY_LIMIT = "0";
    expect(limitFor(user)).toBeNull();
  });

  it("records the tokens each request used and refuses once the allowance is gone", async () => {
    await withAiAllowance(user, "ask", 3, async (s) => { s.push(...sink(1000)); return "ok"; });
    await withAiAllowance(user, "design", 3, async (s) => { s.push(...sink(10)); });
    expect(stored).toHaveLength(2);
    expect(stored[0]).toMatchObject({ userId: 7, kind: "ask", applicationId: 3, promptTokens: 1000, totalTokens: 2000 });
    await expect(checkAllowance(user)).rejects.toMatchObject({ status: 429 });
    await expect(withAiAllowance(user, "ask", 3, async () => "never")).rejects.toThrow(/used all 2 AI requests/);
  });

  it("counts requests still running", async () => {
    process.env.AI_DAILY_LIMIT = "1";
    let release!: () => void;
    const first = withAiAllowance(user, "app_generate", null, (s) => new Promise((resolve) => { s.push(...sink(5)); release = () => resolve("done"); }));
    await new Promise((r) => setTimeout(r, 0));
    await expect(withAiAllowance(user, "ask", null, async () => "x")).rejects.toMatchObject({ status: 429 });
    release();
    await first;
    expect(stored.map((r) => r.kind)).toEqual(["app_generate"]);
  });

  it("charges a failed request only for tokens it actually used", async () => {
    process.env.AI_DAILY_LIMIT = "5";
    await withAiAllowance(user, "ask", null, async () => { throw new Error("network"); }).catch(() => {});
    await withAiAllowance(user, "ask", null, async (s) => { s.push(...sink(5)); throw new Error("bad answer"); }).catch(() => {});
    expect(stored).toHaveLength(1);
  });
});

describe("usage summary", () => {
  it("prices tokens and groups by day and kind", () => {
    expect(costUsd("gpt-5.6-luna", 1_000_000, 1_000_000)).toBeCloseTo(1.4);
    const now = new Date("2026-11-13T10:00:00Z");
    const row = (kind: string, at: string, t = 1000) => ({ kind, model: "gpt-5.6-luna", promptTokens: t, completionTokens: t, totalTokens: 2 * t, createdAt: new Date(at) });
    const s = summarize([row("ask", "2026-11-13T01:00:00Z"), row("ask", "2026-11-12T23:00:00Z"), row("app_generate", "2026-11-01T09:00:00Z", 50000)], now);
    expect(s.today.requests).toBe(1);
    expect(s.last30Days).toMatchObject({ requests: 3, tokens: 104000 });
    expect(s.days).toHaveLength(14);
    expect(s.days.at(-1)).toMatchObject({ date: "2026-11-13", requests: 1 });
    expect(s.byKind[0]).toMatchObject({ kind: "ask", requests: 2 });
    expect(nextUtcMidnight(now).toISOString()).toBe("2026-11-14T00:00:00.000Z");
  });
});
