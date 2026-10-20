import { describe, expect, it, vi } from "vitest";
import { evaluateCondition, evaluateExpression, type ExpressionContext } from "./expressions.js";

function ctx(overrides: Partial<ExpressionContext> = {}): ExpressionContext {
  return { fields: {}, related: {}, session: {}, ...overrides };
}

describe("expressions: evaluateCondition — the real sample Validations", () => {
  it("orderDate <= now() — true for today, false for a future date", () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(evaluateCondition("orderDate <= now()", ctx({ fields: { orderDate: today } }))).toBe(true);

    const future = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString().slice(0, 10);
    expect(evaluateCondition("orderDate <= now()", ctx({ fields: { orderDate: future } }))).toBe(false);
  });

  it("totalAmount == sum(lineItems.amount) — compares a field against a pre-fetched related aggregate", () => {
    const related = { lineItems: [{ amount: 10 }, { amount: 25.5 }] };
    expect(evaluateCondition("totalAmount == sum(lineItems.amount)", ctx({ fields: { totalAmount: 35.5 }, related }))).toBe(true);
    expect(evaluateCondition("totalAmount == sum(lineItems.amount)", ctx({ fields: { totalAmount: 10 }, related }))).toBe(false);
  });

  it("age(dateOfBirth) < 24 — the earlier Student example's validation style", () => {
    const seventeenYearsAgo = new Date();
    seventeenYearsAgo.setFullYear(seventeenYearsAgo.getFullYear() - 17);
    expect(evaluateCondition(`age(dateOfBirth) < 24`, ctx({ fields: { dateOfBirth: seventeenYearsAgo.toISOString().slice(0, 10) } }))).toBe(true);

    const thirtyYearsAgo = new Date();
    thirtyYearsAgo.setFullYear(thirtyYearsAgo.getFullYear() - 30);
    expect(evaluateCondition(`age(dateOfBirth) < 24`, ctx({ fields: { dateOfBirth: thirtyYearsAgo.toISOString().slice(0, 10) } }))).toBe(false);
  });
});

describe("expressions: malformed input fails soft (never throws), same precedent as the old engine", () => {
  it("no comparator at all -> false, with a warning logged", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(evaluateCondition("not a real condition", ctx())).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
  it("a reference to a non-existent related alias -> false, not a throw", () => {
    expect(evaluateCondition("totalAmount == sum(nonexistent.amount)", ctx({ fields: { totalAmount: 5 } }))).toBe(false);
  });
});

describe("expressions: evaluateExpression — <Set value=\"...\">", () => {
  it("a bare word is the literal string itself, never a field lookup", () => {
    expect(evaluateExpression("draft", ctx({ fields: { draft: "SOMETHING ELSE" } }))).toBe("draft");
  });
  it("{session.branch} resolves from session context", () => {
    expect(evaluateExpression("{session.branch}", ctx({ session: { branch: "NYC" } }))).toBe("NYC");
  });
  it("sum(lineItems.amount) aggregates the same way inside a Set value", () => {
    expect(evaluateExpression("sum(lineItems.amount)", ctx({ related: { lineItems: [{ amount: 1 }, { amount: 2 }] } }))).toBe(3);
  });
});
