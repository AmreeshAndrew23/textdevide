/**
 * Outgoing email: invites, verification and reset codes, and Notify steps. Sent over HTTPS (Railway
 * Hobby blocks SMTP) through Brevo when BREVO_API_KEY is set, else SendGrid when SENDGRID_API_KEY
 * is. Never part of the write transaction it's about: a slow or failed send must never roll back a
 * real save, and a save that rolls back must never have emailed anyone — callers send only after
 * their transaction commits.
 *
 * Settings: BREVO_API_KEY (or SENDGRID_API_KEY), EMAIL_FROM (a sender address verified with that
 * provider; SENDGRID_FROM_EMAIL still works) and optionally EMAIL_FROM_NAME.
 */
import sgMail from "@sendgrid/mail";

export type EmailProvider = "brevo" | "sendgrid";

export function emailProvider(): EmailProvider | null {
  if (!senderAddress()) return null;
  if (process.env.BREVO_API_KEY) return "brevo";
  if (process.env.SENDGRID_API_KEY) return "sendgrid";
  return null;
}

function senderAddress(): string {
  return process.env.EMAIL_FROM || process.env.SENDGRID_FROM_EMAIL || "";
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// A plain, readable message: the text as written, with a lone link on its own line shown as a
// button and any other link made clickable.
export function emailHtml(subject: string, body: string, fromName: string): string {
  const url = /(https?:\/\/[^\s<]+)/g;
  const paragraphs = body.split(/\n{2,}/).map((block) => {
    const trimmed = block.trim();
    const lead = trimmed.match(/^(.*?)(https?:\/\/\S+)$/s);
    if (lead && !/https?:\/\//.test(lead[1])) {
      const text = lead[1].trim();
      return `${text ? `<p style="margin:0 0 14px">${escapeHtml(text).replace(/\n/g, "<br>")}</p>` : ""}`
        + `<p style="margin:0 0 18px"><a href="${escapeHtml(lead[2])}" style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;padding:11px 20px;border-radius:8px;font-weight:600">Open link</a></p>`
        + `<p style="margin:0 0 14px;font-size:12px;color:#6b7280;word-break:break-all">${escapeHtml(lead[2])}</p>`;
    }
    return `<p style="margin:0 0 14px">${escapeHtml(trimmed).replace(url, (u) => `<a href="${u}" style="color:#4f46e5">${u}</a>`).replace(/\n/g, "<br>")}</p>`;
  });
  return `<!doctype html><html><body style="margin:0;background:#f4f4f5;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#18181b">
<div style="max-width:560px;margin:0 auto;padding:28px 16px">
<div style="background:#fff;border-radius:12px;padding:28px;border:1px solid #e4e4e7">
<h1 style="font-size:18px;margin:0 0 18px">${escapeHtml(subject)}</h1>
<div style="font-size:15px;line-height:1.55">${paragraphs.join("")}</div>
</div>
<p style="font-size:12px;color:#71717a;text-align:center;margin:16px 0 0">Sent by ${escapeHtml(fromName)}</p>
</div></body></html>`;
}

let sendgridKeySet = false;

async function sendWithBrevo(to: string, subject: string, text: string, html: string, fromName: string): Promise<void> {
  const resp = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": process.env.BREVO_API_KEY!, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ sender: { name: fromName, email: senderAddress() }, to: [{ email: to }], subject, textContent: text, htmlContent: html }),
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) throw new Error(`Brevo ${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 300)}`);
}

async function sendWithSendgrid(to: string, subject: string, text: string, html: string, fromName: string): Promise<void> {
  if (!sendgridKeySet) {
    sgMail.setApiKey(process.env.SENDGRID_API_KEY!);
    sendgridKeySet = true;
  }
  await sgMail.send({ to, from: { email: senderAddress(), name: fromName }, subject, text, html });
}

// Never throws — a missing setting or a provider failure is logged and swallowed, since whatever
// the email is about has already happened. Returns whether it was handed to the provider.
export async function sendEmail(to: string, subject: string, body: string, opts: { fromName?: string } = {}): Promise<boolean> {
  if (!to) return false;
  const provider = emailProvider();
  if (!provider) {
    console.warn(`Email isn't set up (BREVO_API_KEY and EMAIL_FROM) — email to ${JSON.stringify(to)} (subject ${JSON.stringify(subject)}) was not sent.`);
    return false;
  }
  const fromName = (opts.fromName || process.env.EMAIL_FROM_NAME || "TextDev").replace(/[\r\n"<>]/g, "").slice(0, 70);
  const cleanSubject = subject.replace(/[\r\n]+/g, " ").slice(0, 200);
  try {
    const html = emailHtml(cleanSubject, body, fromName);
    if (provider === "brevo") await sendWithBrevo(to, cleanSubject, body, html, fromName);
    else await sendWithSendgrid(to, cleanSubject, body, html, fromName);
    return true;
  } catch (e) {
    console.error(`Failed to send email to ${JSON.stringify(to)}: ${e instanceof Error ? e.message : e}`);
    return false;
  }
}
