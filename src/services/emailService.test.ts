import { afterEach, describe, expect, it, vi } from "vitest";
import { emailHtml, emailProvider, sendEmail } from "./emailService.js";
import { allowAttempt } from "../runtimeEngine/attemptLimiter.js";

const KEYS = ["BREVO_API_KEY", "SENDGRID_API_KEY", "EMAIL_FROM", "SENDGRID_FROM_EMAIL"];
afterEach(() => { for (const k of KEYS) delete process.env[k]; vi.unstubAllGlobals(); });

describe("email delivery", () => {
  it("needs a provider key and a sender address", () => {
    for (const k of KEYS) delete process.env[k];
    expect(emailProvider()).toBeNull();
    process.env.BREVO_API_KEY = "k";
    expect(emailProvider()).toBeNull();
    process.env.EMAIL_FROM = "hello@clinic.example";
    expect(emailProvider()).toBe("brevo");
  });

  it("sends through Brevo's API with the app's name as the sender", async () => {
    process.env.BREVO_API_KEY = "secret";
    process.env.EMAIL_FROM = "hello@clinic.example";
    const fetchMock = vi.fn(async () => new Response("{}", { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await sendEmail("a@b.co", "You're invited\r\nBcc: x", "Join here:\nhttps://x.example/a/clinic?invite=t", { fromName: "City Clinic" })).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.brevo.com/v3/smtp/email");
    expect((init.headers as Record<string, string>)["api-key"]).toBe("secret");
    const sent = JSON.parse(String(init.body));
    expect(sent).toMatchObject({ sender: { name: "City Clinic", email: "hello@clinic.example" }, to: [{ email: "a@b.co" }], subject: "You're invited Bcc: x" });
    expect(sent.htmlContent).toContain('href="https://x.example/a/clinic?invite=t"');
  });

  it("reports failure instead of throwing", async () => {
    process.env.BREVO_API_KEY = "secret";
    process.env.EMAIL_FROM = "hello@clinic.example";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad sender", { status: 400 })));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await sendEmail("a@b.co", "s", "b")).toBe(false);
  });

  it("escapes what it's given", () => {
    const html = emailHtml("<b>Hi</b>", "Fee <script>x</script> due", "App");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;b&gt;Hi&lt;/b&gt;");
  });
});

describe("attempt limiter", () => {
  it("allows up to the limit in the window, then again once it passes", () => {
    const t = 1_000_000;
    expect([1, 2, 3].map((i) => allowAttempt("app:register:1.2.3.4", 2, 60_000, t + i))).toEqual([true, true, false]);
    expect(allowAttempt("app:register:5.6.7.8", 2, 60_000, t)).toBe(true);
    expect(allowAttempt("app:register:1.2.3.4", 2, 60_000, t + 61_000)).toBe(true);
  });
});
