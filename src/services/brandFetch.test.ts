import { describe, expect, it } from "vitest";
import { isBlockedAddress, validateUrl, extractBrand, fetchBrand, BrandFetchError } from "./brandFetch.js";

// The brand reader makes the server fetch a user-supplied URL — these pin down the SSRF fences.
describe("brandFetch: only public websites can be read", () => {
  it("blocks private, loopback, link-local, CGNAT, multicast and mapped addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "172.32.0.1", "1.1.1.1", "2606:4700:4700::1111"]) expect(isBlockedAddress(ip), ip).toBe(false);
  });

  it("rejects non-web schemes, credentials, odd ports and internal hostnames before any request", () => {
    expect(() => validateUrl("file:///etc/passwd")).toThrow(BrandFetchError);
    expect(() => validateUrl("ftp://example.com")).toThrow(BrandFetchError);
    expect(() => validateUrl("https://user:pass@example.com")).toThrow(BrandFetchError);
    expect(() => validateUrl("http://example.com:8080")).toThrow(BrandFetchError);
    expect(() => validateUrl("http://127.0.0.1")).toThrow(BrandFetchError);
    expect(() => validateUrl("http://[::1]/")).toThrow(BrandFetchError);
    expect(() => validateUrl("http://localhost")).toThrow(BrandFetchError);
    expect(validateUrl("example.com").toString()).toBe("https://example.com/");
  });

  it("refuses a hostname that resolves to an internal address at connect time", async () => {
    // localhost.localdomain-style names aren't caught by the hostname pattern; the connect-time
    // lookup is what refuses them. "127.0.0.1.nip.io" style needs DNS, so use a name every OS
    // resolves locally instead.
    await expect(fetchBrand("http://localhost.")).rejects.toBeInstanceOf(BrandFetchError);
  });
});

describe("brandFetch.extractBrand: reads brand colors and fonts from a page", () => {
  it("ranks theme-color and brand-named custom properties above incidental colors", () => {
    const html = `<html><head><title>Acme Coffee</title><meta name="theme-color" content="#7c2d12"></head><body style="color:#333333">x</body></html>`;
    const css = `:root{--brand-primary:#0f766e;--accent-color:#f59e0b} a{color:#2563eb} .x{color:#2563eb} body{font-family:"Playfair Display", serif} p{font-family:Inter}`;
    const b = extractBrand(html, css);
    expect(b.title).toBe("Acme Coffee");
    expect(b.themeColor).toBe("#7c2d12");
    expect(b.colors.slice(0, 3)).toEqual(["#7c2d12", "#0f766e", "#f59e0b"]);
    expect(b.colors).not.toContain("#333333"); // grey, not a brand color
    expect(b.fonts).toEqual(expect.arrayContaining(["Playfair Display", "Inter"]));
  });
});
