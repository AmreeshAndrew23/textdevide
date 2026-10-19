import { describe, expect, it, vi, afterEach } from "vitest";
import { callOpenAI, callOpenAIWithTools } from "./aiService.js";

// Regression test for a real incident: switching the platform's default model to gpt-5.6-luna
// broke every single AI generation call, because that model 400s on ANY explicit temperature
// other than its default (1) — including the 0 every call site relying on the default silently
// sent. Mocks fetch entirely so this never makes a real network call either way.
describe("aiService: fixed-temperature models never get a temperature in the request body", () => {
  afterEach(() => vi.unstubAllGlobals());

  function mockChatCompletion() {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: {} }),
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("callOpenAI omits temperature entirely for the default model (gpt-5.6-luna)", async () => {
    const fetchMock = mockChatCompletion();
    await callOpenAI([{ role: "user", content: "hi" }]);
    const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sentBody.model).toBe("gpt-5.6-luna");
    expect(sentBody).not.toHaveProperty("temperature");
  });

  it("callOpenAI still sends temperature for a model that supports it", async () => {
    const fetchMock = mockChatCompletion();
    await callOpenAI([{ role: "user", content: "hi" }], { model: "gpt-4o", temperature: 0.4 });
    const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sentBody.model).toBe("gpt-4o");
    expect(sentBody.temperature).toBe(0.4);
  });

  it("callOpenAIWithTools omits temperature entirely for the default model too", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: {} }),
    });
    vi.stubGlobal("fetch", fetchMock);
    await callOpenAIWithTools([{ role: "user", content: "hi" }], []);
    const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sentBody.model).toBe("gpt-5.6-luna");
    expect(sentBody).not.toHaveProperty("temperature");
  });
});
