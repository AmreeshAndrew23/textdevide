import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { isLocked, recordFailure, recordSuccess } from "./loginAttemptGuard.js";

describe("loginAttemptGuard", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("is not locked before any failures", () => {
    expect(isLocked(1, "alice")).toBe(false);
  });

  it("locks after 5 failures within the window, keyed per application+username", () => {
    for (let i = 0; i < 4; i++) recordFailure(1, "alice");
    expect(isLocked(1, "alice")).toBe(false); // 4 failures, not locked yet
    recordFailure(1, "alice");
    expect(isLocked(1, "alice")).toBe(true); // 5th failure locks it

    // A different application, or a different username, is unaffected.
    expect(isLocked(2, "alice")).toBe(false);
    expect(isLocked(1, "bob")).toBe(false);
  });

  it("is case-insensitive on the username", () => {
    for (let i = 0; i < 5; i++) recordFailure(1, "Alice");
    expect(isLocked(1, "alice")).toBe(true);
  });

  it("recordSuccess clears the lockout", () => {
    for (let i = 0; i < 5; i++) recordFailure(1, "alice");
    expect(isLocked(1, "alice")).toBe(true);
    recordSuccess(1, "alice");
    expect(isLocked(1, "alice")).toBe(false);
  });

  it("the window resets after 15 minutes", () => {
    for (let i = 0; i < 5; i++) recordFailure(1, "alice");
    expect(isLocked(1, "alice")).toBe(true);
    vi.advanceTimersByTime(16 * 60 * 1000);
    expect(isLocked(1, "alice")).toBe(false);
  });
});
