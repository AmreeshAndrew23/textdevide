/**
 * Thin SendGrid wrapper for a generated app's own <email> step (see runtime/engine.ts) — e.g. a
 * Student Master screen emailing a newly-provisioned Account its temporary password. Separate from
 * anything the Studio itself sends (there isn't any), and deliberately NOT part of the write
 * transaction that creates the row it's emailing about: a slow/failed send must never roll back a
 * real account creation, and a successful creation must never be undone by a bounced email — see
 * previewDb.ts's run-event route, which calls this only after the transaction has committed.
 */
import sgMail from "@sendgrid/mail";

let configured = false;
function ensureConfigured(): boolean {
  const key = process.env.SENDGRID_API_KEY;
  if (!key) return false;
  if (!configured) {
    sgMail.setApiKey(key);
    configured = true;
  }
  return true;
}

// Never throws — a missing key or a provider-side failure is logged and swallowed, since the
// record this email is about (e.g. the Account it just issued credentials for) already exists
// either way; losing the notification isn't a reason to tell the caller their save failed.
export async function sendEmail(to: string, subject: string, body: string): Promise<void> {
  if (!to) return;
  if (!ensureConfigured()) {
    console.warn(`SENDGRID_API_KEY not set — email to ${JSON.stringify(to)} (subject ${JSON.stringify(subject)}) was not sent.`);
    return;
  }
  const from = process.env.SENDGRID_FROM_EMAIL;
  if (!from) {
    console.warn(`SENDGRID_FROM_EMAIL not set — email to ${JSON.stringify(to)} was not sent.`);
    return;
  }
  try {
    await sgMail.send({ to, from, subject, text: body });
  } catch (e) {
    console.error(`Failed to send email to ${JSON.stringify(to)}: ${e instanceof Error ? e.message : e}`);
  }
}
