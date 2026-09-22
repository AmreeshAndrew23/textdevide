import { describe, expect, it } from "vitest";
import { raceAbort, RequestAbortedError } from "./requestAbort.js";

describe("raceAbort", () => {
  it("resolves with the promise's value when it settles before the signal aborts", async () => {
    const result = await raceAbort(Promise.resolve("done"), new AbortController().signal);
    expect(result).toBe("done");
  });

  it("rejects with RequestAbortedError as soon as the signal aborts, without waiting for the promise", async () => {
    const never = new Promise(() => {}); // simulates a hung Neo4j call that never settles on its own
    const controller = new AbortController();
    const t0 = Date.now();
    setTimeout(() => controller.abort(), 30);
    await expect(raceAbort(never, controller.signal)).rejects.toBeInstanceOf(RequestAbortedError);
    expect(Date.now() - t0).toBeLessThan(200); // proves it didn't wait for `never` to settle
  });

  it("rejects immediately if the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(raceAbort(new Promise(() => {}), controller.signal)).rejects.toBeInstanceOf(RequestAbortedError);
  });

  it("still propagates the promise's own rejection when it loses the race legitimately", async () => {
    const controller = new AbortController();
    await expect(raceAbort(Promise.reject(new Error("boom")), controller.signal)).rejects.toThrow("boom");
  });
});
