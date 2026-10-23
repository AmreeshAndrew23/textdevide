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

describe("expressions: a bare alias.field (to-one relationship) and arithmetic — the real Insurance Claims case found live", () => {
  it("claimAmount <= policy.premiumAmount * 10 — a bare dotted reference times a literal", () => {
    const policy = { related: { policy: [{ premiumAmount: 500 }] } };
    expect(evaluateCondition("claimAmount <= policy.premiumAmount * 10", ctx({ fields: { claimAmount: 4999 }, ...policy }))).toBe(true);
    expect(evaluateCondition("claimAmount <= policy.premiumAmount * 10", ctx({ fields: { claimAmount: 5001 }, ...policy }))).toBe(false);
  });

  it("a hyphenated literal enum value is NEVER mistaken for subtraction (the actual regression this fix needed)", () => {
    // "pending-approval" has no spaces around its hyphen — must resolve as the literal string, not
    // (NaN from "pending") minus (NaN from "approval"). This is exactly the value <Set
    // field="status" value="pending-approval"/> uses in this vocabulary's own worked example.
    expect(evaluateExpression("pending-approval", ctx())).toBe("pending-approval");
  });

  it("basic +, -, / with required whitespace around the operator", () => {
    expect(evaluateExpression("totalAmount + 5", ctx({ fields: { totalAmount: 10 } }))).toBe(15);
    expect(evaluateExpression("totalAmount - 5", ctx({ fields: { totalAmount: 10 } }))).toBe(5);
    expect(evaluateExpression("totalAmount / 2", ctx({ fields: { totalAmount: 10 } }))).toBe(5);
  });

  it("a negative number literal is never mistaken for a subtraction with an empty left side", () => {
    expect(evaluateExpression("-5", ctx())).toBe(-5);
  });
});

describe("expressions: evaluateCondition — and/or combining two whole comparisons (a real range-check bug)", () => {
  // Regression test for a real incident: the AI wrote "hoursWorked >= 0 and hoursWorked <= 24"
  // for a Timesheet Validation — a perfectly natural range check — and it silently rejected
  // EVERY value regardless of whether it was actually in range, because nothing ever split on
  // "and" at all: the comparator regex took the first ">=" and treated the whole remainder
  // ("0 and hoursWorked <= 24") as one unresolvable right-hand operand.
  it("a range check with \"and\" passes when both sides hold", () => {
    expect(evaluateCondition("hoursWorked >= 0 and hoursWorked <= 24", ctx({ fields: { hoursWorked: 8 } }))).toBe(true);
  });
  it("the same range check fails when either side doesn't hold", () => {
    expect(evaluateCondition("hoursWorked >= 0 and hoursWorked <= 24", ctx({ fields: { hoursWorked: 25 } }))).toBe(false);
    expect(evaluateCondition("hoursWorked >= 0 and hoursWorked <= 24", ctx({ fields: { hoursWorked: -1 } }))).toBe(false);
  });
  it("\"or\" passes when at least one side holds", () => {
    expect(evaluateCondition("status == \"draft\" or status == \"pending\"", ctx({ fields: { status: "pending" } }))).toBe(true);
    expect(evaluateCondition("status == \"draft\" or status == \"pending\"", ctx({ fields: { status: "approved" } }))).toBe(false);
  });
  it("never mistakes a field name merely CONTAINING \"and\"/\"or\" as substring for the keyword", () => {
    // "brandId" contains the letters "and"; "corporation" contains "or" — neither has whitespace
    // around that substring, so LOGICAL_RE must not split on it.
    expect(evaluateCondition("brandId == 5", ctx({ fields: { brandId: 5 } }))).toBe(true);
    expect(evaluateCondition("corporation == true", ctx({ fields: { corporation: true } }))).toBe(true);
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
