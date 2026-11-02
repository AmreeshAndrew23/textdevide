import http from "node:http";
import https from "node:https";
import net from "node:net";
import dns from "node:dns";

// "Bring your own brand" for the Studio's Design tab — reads a public website's brand colors and
// fonts so a generated app can match it. Because this makes the SERVER fetch a user-supplied URL
// (a classic SSRF vector), every request is fenced:
//   - http/https only, default ports only, no credentials in the URL;
//   - DNS is resolved through a custom lookup that rejects private, loopback, link-local,
//     CGNAT, multicast and reserved addresses AT CONNECT TIME — so a hostname that re-resolves to
//     an internal IP between "check" and "connect" (DNS rebinding) is still refused;
//   - redirects are followed manually (max 3), each hop re-validated the same way;
//   - 6s timeout per request, response bodies capped (HTML 1.5 MB, CSS 600 KB), text only.

export class BrandFetchError extends Error {}

// Same list the frontend's designProfile.js loads from Google Fonts.
export const FONT_WHITELIST = [
  "Inter", "Plus Jakarta Sans", "DM Sans", "Manrope", "Poppins", "Nunito", "Nunito Sans", "IBM Plex Sans",
  "Space Grotesk", "Outfit", "Lexend", "Work Sans", "Rubik", "Sora", "Figtree", "Archivo", "Source Sans 3",
  "Barlow", "Fraunces", "Playfair Display", "Lora",
];

export function isBlockedAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || // CGNAT
      (a === 169 && b === 254) || // link-local / cloud metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
    if (mapped) return isBlockedAddress(mapped[1]);
    return v === "::" || v === "::1" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe8") || v.startsWith("fe9")
      || v.startsWith("fea") || v.startsWith("feb") || v.startsWith("ff");
  }
  return true;
}

// Plugged into http(s).request as `lookup`: resolves, then refuses if ANY candidate is internal.
const safeLookup: net.LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { all: true }, (err, addresses) => {
    if (err) return callback(err, "", 4);
    const list = addresses as dns.LookupAddress[];
    if (list.length === 0 || list.some((a) => isBlockedAddress(a.address))) {
      return callback(new BrandFetchError("That address points to a private or internal network."), "", 4);
    }
    const wantAll = typeof options === "object" && options && (options as dns.LookupAllOptions).all;
    if (wantAll) return (callback as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, list);
    return callback(null, list[0].address, list[0].family);
  });
};

export function validateUrl(raw: string): URL {
  let url: URL;
  // An explicit scheme that isn't http(s) is refused outright — only a bare host ("example.com")
  // gets https:// added.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw.trim()) && !/^https?:\/\//i.test(raw.trim())) {
    throw new BrandFetchError("Only http and https websites are supported.");
  }
  try {
    url = new URL(/^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`);
  } catch {
    throw new BrandFetchError("That doesn't look like a valid website address.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new BrandFetchError("Only http and https websites are supported.");
  if (url.username || url.password) throw new BrandFetchError("Website addresses with credentials aren't supported.");
  if (url.port && url.port !== "80" && url.port !== "443") throw new BrandFetchError("Only standard web ports are supported.");
  if (net.isIP(url.hostname.replace(/^\[|\]$/g, "")) && isBlockedAddress(url.hostname.replace(/^\[|\]$/g, ""))) {
    throw new BrandFetchError("That address points to a private or internal network.");
  }
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(url.hostname)) throw new BrandFetchError("That address points to a private or internal network.");
  return url;
}

function getOnce(url: URL, maxBytes: number): Promise<{ status: number; location?: string; body: string; contentType: string }> {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request(
      url,
      { method: "GET", lookup: safeLookup, timeout: 6000, headers: { "User-Agent": "TextDevBrandReader/1.0", Accept: "text/html,text/css;q=0.9,*/*;q=0.5" } },
      (res) => {
        const status = res.statusCode || 0;
        const contentType = String(res.headers["content-type"] || "");
        if (status >= 300 && status < 400) {
          res.resume();
          return resolve({ status, location: res.headers.location, body: "", contentType });
        }
        let size = 0;
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > maxBytes) { res.destroy(); return; }
          chunks.push(c);
        });
        res.on("end", () => resolve({ status, body: Buffer.concat(chunks).toString("utf8"), contentType }));
        res.on("close", () => resolve({ status, body: Buffer.concat(chunks).toString("utf8"), contentType }));
        res.on("error", reject);
      }
    );
    req.on("timeout", () => req.destroy(new BrandFetchError("The website took too long to respond.")));
    req.on("error", (e) => reject(e instanceof BrandFetchError ? e : new BrandFetchError(`Couldn't reach that website (${e.message}).`)));
    req.end();
  });
}

async function safeGet(start: URL, maxBytes: number): Promise<{ url: URL; body: string; contentType: string }> {
  let url = start;
  for (let hop = 0; hop <= 3; hop++) {
    const res = await getOnce(url, maxBytes);
    if (res.status >= 300 && res.status < 400 && res.location) {
      url = validateUrl(new URL(res.location, url).toString());
      continue;
    }
    if (res.status >= 400) throw new BrandFetchError(`The website answered with an error (${res.status}).`);
    return { url, body: res.body, contentType: res.contentType };
  }
  throw new BrandFetchError("The website redirected too many times.");
}

function normalizeHex(h: string): string | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(h.trim());
  if (!m) return null;
  const v = m[1].length === 3 ? m[1].split("").map((c) => c + c).join("") : m[1];
  return `#${v.toLowerCase()}`;
}

function isBrandish(hex: string): boolean {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const hi = Math.max(r, g, b), lo = Math.min(r, g, b);
  return hi - lo >= 28 && hi >= 40 && !(hi > 238 && lo > 220);
}

// Pure extraction — exported for tests. css: the page's own <style> text plus fetched stylesheets.
export function extractBrand(html: string, css: string) {
  const title = (/<title[^>]*>([^<]{1,120})<\/title>/i.exec(html)?.[1] || "").trim();
  const themeColor = normalizeHex(/<meta[^>]+name=["']theme-color["'][^>]*content=["']([^"']+)["']/i.exec(html)?.[1]
    || /<meta[^>]+content=["']([^"']+)["'][^>]*name=["']theme-color["']/i.exec(html)?.[1] || "");
  const all = `${html}\n${css}`;
  const scores = new Map<string, number>();
  const bump = (hex: string | null, by: number) => { if (hex && isBrandish(hex)) scores.set(hex, (scores.get(hex) || 0) + by); };
  // Custom properties named like brand colors count much more than incidental ones.
  for (const m of all.matchAll(/--[\w-]*(primary|brand|accent|main|theme)[\w-]*\s*:\s*(#[0-9a-f]{3,6})\b/gi)) bump(normalizeHex(m[2]), 25);
  for (const m of all.matchAll(/#[0-9a-f]{6}\b|#[0-9a-f]{3}\b/gi)) bump(normalizeHex(m[0]), 1);
  if (themeColor) bump(themeColor, 40);
  const colors = [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([h]) => h).slice(0, 6);

  const fontHits = new Map<string, number>();
  for (const f of FONT_WHITELIST) {
    const re = new RegExp(`["']?${f.replace(/ /g, "[ +]")}["']?`, "gi");
    const n = (all.match(re) || []).length;
    if (n > 0) fontHits.set(f, n);
  }
  const fonts = [...fontHits.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f).slice(0, 3);
  return { title, themeColor, colors, fonts };
}

export async function fetchBrand(rawUrl: string) {
  const start = validateUrl(rawUrl);
  const page = await safeGet(start, 1_500_000);
  if (!/html|xml|text\/plain/i.test(page.contentType || "text/html")) throw new BrandFetchError("That address isn't a web page.");
  const inlineCss = [...page.body.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join("\n");
  // Up to two of the page's own stylesheets (same site only), for colors and fonts kept in CSS files.
  const sheetUrls = [...page.body.matchAll(/<link[^>]+rel=["']?stylesheet["']?[^>]*>/gi)]
    .map((m) => /href=["']([^"']+)["']/i.exec(m[0])?.[1])
    .filter((h): h is string => !!h)
    .map((h) => { try { return new URL(h, page.url); } catch { return null; } })
    .filter((u): u is URL => !!u && u.hostname === page.url.hostname)
    .slice(0, 2);
  const sheets: string[] = [];
  for (const u of sheetUrls) {
    try { sheets.push((await safeGet(validateUrl(u.toString()), 600_000)).body); } catch { /* a missing stylesheet just means fewer colors */ }
  }
  // Google Fonts links name the families directly — include their URLs in the scanned text.
  const fontLinks = [...page.body.matchAll(/fonts\.googleapis\.com\/css2?\?[^"'>\s]+/gi)].map((m) => decodeURIComponent(m[0]));
  const brand = extractBrand(page.body, [inlineCss, ...sheets, ...fontLinks].join("\n"));
  if (brand.colors.length === 0 && brand.fonts.length === 0) throw new BrandFetchError("Couldn't find any brand colors or fonts on that page.");
  return brand;
}
