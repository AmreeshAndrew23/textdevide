import { describe, expect, it, vi, afterEach } from "vitest";
import { callOpenAI, callOpenAIWithTools, generateApplicationXml, generateApplicationFixXml } from "./aiService.js";

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

describe("aiService.generateApplicationXml: the from-scratch prompt (no existing application)", () => {
  afterEach(() => vi.unstubAllGlobals());

  function mockXmlResponse(xml: string) {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: xml }, finish_reason: "stop" }], usage: {} }),
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("sends only the from-scratch prompt, never a fix/fragment instruction", async () => {
    const fetchMock = mockXmlResponse(`<Application name="Fresh"></Application>`);
    await generateApplicationXml("A simple todo app.");
    const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    const userMessage = sentBody.messages.find((m: { role: string }) => m.role === "user").content;
    expect(userMessage).not.toMatch(/fixing or extending an EXISTING Application/);
    expect(userMessage).toContain("A simple todo app.");
  });

  it("still validates the AI's own output and throws a clear error on malformed XML", async () => {
    mockXmlResponse("not xml at all {{{");
    await expect(generateApplicationXml("whatever")).rejects.toThrow(/Generated XML failed to parse/);
  });
});

// Regression coverage for the incremental "describe a fix/change to an existing application"
// flow — caught live: the OLD approach asked the AI to reproduce the WHOLE application on every
// change, and any slip reproducing an unrelated screen was a silent regression. Now the AI sees
// the full current XML for context but is told to output ONLY a fragment of what's new/changed,
// which applicationStore.ts's mergeApplicationNodes then applies surgically.
describe("aiService.generateApplicationFixXml: outputs a targeted fragment, not a full rework", () => {
  afterEach(() => vi.unstubAllGlobals());

  function mockXmlResponse(xml: string) {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: xml }, finish_reason: "stop" }], usage: {} }),
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("includes the current XML for context and the fragment-only output contract", async () => {
    const existing = `<Application name="Todo"><Entity name="Task"><Field name="id" type="string" key="true"/></Entity></Application>`;
    const fetchMock = mockXmlResponse(`<Application><Entity name="Category"><Field name="id" type="string" key="true"/></Entity></Application>`);
    await generateApplicationFixXml("Also add a Category entity.", existing);
    const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    const userMessage = sentBody.messages.find((m: { role: string }) => m.role === "user").content;
    expect(userMessage).toMatch(/fixing or extending an EXISTING Application/);
    expect(userMessage).toContain(existing);
    expect(userMessage).toContain("Also add a Category entity.");
    expect(userMessage).toContain("ONLY the top-level elements");
    expect(userMessage).toMatch(/that are BRAND NEW or that actually NEED TO CHANGE/);
  });

  it("still validates the AI's own fragment output and throws a clear error on malformed XML", async () => {
    mockXmlResponse("not xml at all {{{");
    await expect(generateApplicationFixXml("whatever", `<Application name="X"></Application>`)).rejects.toThrow(/Generated fix XML failed to parse/);
  });
});
