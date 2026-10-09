import { describe, expect, it } from "vitest";
import { cookieName, signAppSession, verifyAppSession } from "./appSession.js";

describe("appSession: the generated app's own login session (separate from the builder JWT)", () => {
  it("round-trips: a token signed for a project verifies for that same project", () => {
    const token = signAppSession(42);
    expect(verifyAppSession(token, 42)).toBe(true);
  });
  it("a token signed for one project is rejected for another — sessions don't cross projects", () => {
    const token = signAppSession(42);
    expect(verifyAppSession(token, 43)).toBe(false);
  });
  it("rejects missing, empty, and garbage tokens instead of throwing", () => {
    expect(verifyAppSession(undefined, 42)).toBe(false);
    expect(verifyAppSession("", 42)).toBe(false);
    expect(verifyAppSession("not-a-real-token", 42)).toBe(false);
  });
  it("cookie names are project-scoped so logging into one app doesn't affect another in the same browser", () => {
    expect(cookieName(1)).not.toBe(cookieName(2));
    expect(cookieName(42)).toBe("td_session_42");
  });
});
