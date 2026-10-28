/**
 * Action/Steps execution + built-in button semantics — "Built-ins (save, cancel, delete,
 * openRecord) have fixed runtime semantics and are never redefined. Custom logic lives in named
 * actions composed of runtime steps; all steps run in one transaction." The caller (the route
 * layer) wraps the whole call in runtime/neo4jStore.ts's withTx, same as everywhere else that
 * touches Neo4j — this module takes an already-open Transaction, it never opens one itself.
 *
 * openRecord's actual navigation (a Grid row's rowClick -> targetScreen) is pure routing with no
 * database involvement at all, so it's resolved directly from ScreenDef.grid.onEvents by the
 * caller — there is deliberately no runtime function for it here.
 */
import type { Transaction } from "neo4j-driver";
import { randomUUID } from "crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { EntityDef, RelationshipDef, ValidationDef, AuditingDef, ActionDef } from "./applicationModel.js";
import { evaluateExpression, type ExpressionContext } from "./expressions.js";
import {
  saveEntityRow, deleteEntityRow, getEntityRowByField, setEntityOtp, consumeEntityOtp,
  ValidationError, ConcurrencyError,
} from "./entityStore.js";
import { hashPassword, verifyPassword } from "../services/authService.js";
import { entityLabelFor } from "./labels.js";
import { safeIdent, toDriverValue } from "../runtime/values.js";
import { GOOGLE_CLIENT_ID, GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET } from "../config.js";

export type RuntimeAction =
  // "conflict" is distinct from "error" specifically so the frontend can show the amber
  // reload-latest conflict UI instead of the plain red error banner — see ConcurrencyError below.
  | { type: "message"; messageType: "success" | "error" | "info" | "conflict"; value: string }
  | { type: "fieldUpdate"; field: string; value: unknown }
  // Login/changePassword signal a session change this way rather than touching a cookie directly
  // — this module takes an already-open Transaction and knows nothing about HTTP; the route layer
  // (which does) turns this into a Set-Cookie using appAuth.ts after the transaction commits. role
  // is the RBAC convention's resolved AccessRole name (see resolveAccountRole below) — null for
  // every app that doesn't use the optional roleId field.
  | { type: "session"; identity: string; mustChangePassword: boolean; role?: string | null }
  // Pure data, same reasoning as "session" above — this module never does I/O inside the open
  // transaction it was handed, so it can't call emailService.ts's sendEmail directly (a slow/failed
  // send must never risk the transaction, and a transaction that later rolls back must never have
  // already emailed someone). The route layer sends it AFTER the transaction commits.
  | { type: "sendEmail"; to: string; subject: string; body: string };

export type ActionRunContext = {
  applicationId: number;
  entity: EntityDef;
  relationships: RelationshipDef[];
  validations: ValidationDef[];
  auditing: AuditingDef | null;
  session: { identity: string | null; vars: Record<string, unknown>; role?: string | null };
  tx: Transaction;
};

// RBAC role resolution — strictly conditional on the account entity actually declaring a roleId
// field at all (checked by the caller before this runs), so an application with no roles never
// pays for an extra query. Follows the fixed convention: a Relationship from the account entity's
// roleId field to some other entity's key, whose "name" property is the role's display name —
// the same value a Screen's requiresRole="..." attribute is expected to list.
async function resolveAccountRole(ctx: ActionRunContext, roleId: unknown): Promise<string | null> {
  if (roleId === undefined || roleId === null || roleId === "") return null;
  const rel = ctx.relationships.find((r) => r.fromEntity === ctx.entity.name && r.fromField === "roleId");
  if (!rel) return null;
  const label = entityLabelFor(ctx.applicationId, rel.toEntity);
  const toField = safeIdent(rel.toField);
  const res = await ctx.tx.run(
    `MATCH (r:${label}) WHERE r.${toField} = $roleId AND r.__deletedAt IS NULL RETURN r.name AS name LIMIT 1`,
    { roleId: toDriverValue(roleId) }
  );
  const name = res.records[0]?.get("name");
  return typeof name === "string" ? name : null;
}

function hasField(entity: EntityDef, name: string): boolean {
  return entity.fields.some((f) => f.name === name);
}
function hasRoleIdField(entity: EntityDef): boolean {
  return hasField(entity, "roleId");
}

// Dual-shape support (see applicationModel.ts's looksLikeAccountEntity for the full rationale):
// an older, already-generated app's User entity has "username", a current one has "email" — every
// built-in below picks the right identifier field at runtime instead of assuming one.
function identifierFieldOf(entity: EntityDef): "email" | "username" {
  return hasField(entity, "email") ? "email" : "username";
}

function generateOtpCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

const MINIMUM_SIGNUP_AGE = 18;
function isOldEnough(dob: string, minAge: number): boolean {
  const birth = new Date(dob);
  if (Number.isNaN(birth.getTime())) return false;
  const now = new Date();
  let age = now.getFullYear() - birth.getFullYear();
  const hadBirthdayThisYear = now.getMonth() > birth.getMonth() || (now.getMonth() === birth.getMonth() && now.getDate() >= birth.getDate());
  if (!hadBirthdayThisYear) age -= 1;
  return age >= minAge;
}

function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

// Shared by the Google/GitHub built-ins below — an OAuth provider already vouches for the email,
// so a brand-new account is created pre-verified with no password (login via that same provider
// going forward); an existing row with that email just logs straight in, whichever way it was
// originally created (a password-signup user adding Google later is normal, expected behavior).
async function findOrCreateOAuthRow(
  ctx: ActionRunContext, email: string, firstName: string, lastName: string, provider: string
): Promise<Record<string, unknown>> {
  const existing = await getEntityRowByField(ctx.tx, ctx.applicationId, ctx.entity, "email", email);
  if (existing) return existing;
  const { row } = await saveEntityRow(ctx.tx, ctx.applicationId, ctx.entity, ctx.relationships, ctx.validations, ctx.auditing, {
    id: randomUUID(), email, mustChangePassword: false, firstName, lastName, emailVerified: true, authProvider: provider,
  }, { identity: email });
  return row;
}

const googleJwks = GOOGLE_CLIENT_ID ? createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs")) : null;

// {poNumber} inside a Notify message -> the field's current value — a different placeholder
// grammar from expressions.ts's {session.x} (no "session." prefix, and only ever a plain
// substitution, never an expression), since a Notify message is free text, not a value expression.
function substituteFieldTemplate(template: string, fieldValues: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (full, field: string) => (field in fieldValues ? String(fieldValues[field]) : full));
}

async function runSave(ctx: ActionRunContext, fieldValues: Record<string, unknown>): Promise<RuntimeAction[]> {
  try {
    const { created } = await saveEntityRow(ctx.tx, ctx.applicationId, ctx.entity, ctx.relationships, ctx.validations, ctx.auditing, fieldValues, { identity: ctx.session.identity });
    return [{ type: "message", messageType: "success", value: created ? "Created successfully." : "Saved successfully." }];
  } catch (e) {
    if (e instanceof ConcurrencyError) return [{ type: "message", messageType: "conflict", value: e.message }];
    if (e instanceof ValidationError) return [{ type: "message", messageType: "error", value: e.message }];
    throw e;
  }
}

// login/changePassword only make sense against the one Entity marked isAccount="true" (always
// "User" by the fixed convention documented in aiService.ts's prompt). Branches on
// identifierFieldOf so an already-generated, username-based app keeps working byte-for-byte while
// a current, email-based one gets the new OAuth-aware/verified-email checks.
async function runLogin(ctx: ActionRunContext, fieldValues: Record<string, unknown>): Promise<RuntimeAction[]> {
  if (!ctx.entity.isAccount) throw new Error(`login can only run against the isAccount entity, not "${ctx.entity.name}"`);
  const identifierField = identifierFieldOf(ctx.entity);
  const label = identifierField === "email" ? "Email" : "Username";
  const identifier = String(fieldValues[identifierField] ?? "");
  const password = String(fieldValues.password ?? "");
  if (!identifier || !password) return [{ type: "message", messageType: "error", value: `${label} and password are required.` }];
  const row = await getEntityRowByField(ctx.tx, ctx.applicationId, ctx.entity, identifierField, identifier);
  const invalid: RuntimeAction[] = [{ type: "message", messageType: "error", value: `Invalid ${label.toLowerCase()} or password.` }];
  if (!row) return invalid;
  // Deliberately more specific than the generic "invalid" message above — same tradeoff
  // Google/GitHub's own login pages make: telling a legitimate user their account uses a
  // different sign-in method is more helpful than it is a meaningful enumeration risk.
  if (identifierField === "email" && !row.passwordHash) {
    return [{ type: "message", messageType: "error", value: "This account signs in with Google or GitHub — use that button instead." }];
  }
  if (!verifyPassword(password, String(row.passwordHash ?? ""))) return invalid;
  if (identifierField === "email" && row.emailVerified !== true) {
    return [{ type: "message", messageType: "error", value: "Please verify your email before logging in." }];
  }
  const role = hasRoleIdField(ctx.entity) ? await resolveAccountRole(ctx, row.roleId) : null;
  return [
    { type: "message", messageType: "success", value: "Logged in." },
    { type: "session", identity: identifier, mustChangePassword: row.mustChangePassword === true, role },
  ];
}

// The "first account" problem: login/changePassword alone give no way for the very first real
// end user to ever get an account — there's nothing to log into yet. register creates a new User
// row and, for a current-shape (email-based) entity, sends a 6-digit OTP and does NOT sign the
// user in yet — the account is unusable until verifyEmail confirms it (see routes/
// runtimeApplications.ts's ANONYMOUS_ACTIONS and post-commit sendEmail dispatch). A legacy
// (username-based) entity keeps the old immediate-session behavior untouched.
async function runRegister(ctx: ActionRunContext, fieldValues: Record<string, unknown>): Promise<RuntimeAction[]> {
  if (!ctx.entity.isAccount) throw new Error(`register can only run against the isAccount entity, not "${ctx.entity.name}"`);

  if (!hasField(ctx.entity, "email")) {
    const username = String(fieldValues.username ?? "");
    const password = String(fieldValues.password ?? "");
    if (!username || !password) return [{ type: "message", messageType: "error", value: "Username and password are required." }];
    const existing = await getEntityRowByField(ctx.tx, ctx.applicationId, ctx.entity, "username", username);
    if (existing) return [{ type: "message", messageType: "error", value: "That username is already taken." }];
    try {
      await saveEntityRow(ctx.tx, ctx.applicationId, ctx.entity, ctx.relationships, ctx.validations, ctx.auditing, {
        id: randomUUID(), username, passwordHash: hashPassword(password), mustChangePassword: false,
      }, { identity: username });
    } catch (e) {
      if (e instanceof ConcurrencyError) return [{ type: "message", messageType: "conflict", value: e.message }];
      if (e instanceof ValidationError) return [{ type: "message", messageType: "error", value: e.message }];
      throw e;
    }
    return [
      { type: "message", messageType: "success", value: "Account created." },
      { type: "session", identity: username, mustChangePassword: false, role: null },
    ];
  }

  const email = String(fieldValues.email ?? "").trim();
  const password = String(fieldValues.password ?? "");
  const firstName = String(fieldValues.firstName ?? "").trim();
  const lastName = String(fieldValues.lastName ?? "").trim();
  const dob = String(fieldValues.dob ?? "").trim();
  if (!email || !looksLikeEmail(email)) return [{ type: "message", messageType: "error", value: "A valid email address is required." }];
  if (!password) return [{ type: "message", messageType: "error", value: "Password is required." }];
  if (!firstName || !lastName) return [{ type: "message", messageType: "error", value: "First name and last name are required." }];
  if (!dob || !isOldEnough(dob, MINIMUM_SIGNUP_AGE)) {
    return [{ type: "message", messageType: "error", value: `You must be at least ${MINIMUM_SIGNUP_AGE} years old to create an account.` }];
  }
  const existing = await getEntityRowByField(ctx.tx, ctx.applicationId, ctx.entity, "email", email);
  if (existing) return [{ type: "message", messageType: "error", value: "An account with that email already exists." }];

  const id = randomUUID();
  try {
    await saveEntityRow(ctx.tx, ctx.applicationId, ctx.entity, ctx.relationships, ctx.validations, ctx.auditing, {
      id, email, passwordHash: hashPassword(password), mustChangePassword: false,
      firstName, lastName, dob, emailVerified: false, authProvider: "password",
    }, { identity: email });
  } catch (e) {
    if (e instanceof ConcurrencyError) return [{ type: "message", messageType: "conflict", value: e.message }];
    if (e instanceof ValidationError) return [{ type: "message", messageType: "error", value: e.message }];
    throw e;
  }
  const code = generateOtpCode();
  await setEntityOtp(ctx.tx, ctx.applicationId, ctx.entity, id, "verifyEmail", code, 10);
  return [
    { type: "message", messageType: "success", value: "Account created — check your email for a verification code." },
    { type: "sendEmail", to: email, subject: "Verify your email", body: `Your verification code is ${code}. It expires in 10 minutes.` },
  ];
}

async function runChangePassword(ctx: ActionRunContext, fieldValues: Record<string, unknown>): Promise<RuntimeAction[]> {
  if (!ctx.entity.isAccount) throw new Error(`changePassword can only run against the isAccount entity, not "${ctx.entity.name}"`);
  if (!ctx.session.identity) return [{ type: "message", messageType: "error", value: "You must be logged in to change your password." }];
  const currentPassword = String(fieldValues.currentPassword ?? "");
  const newPassword = String(fieldValues.newPassword ?? "");
  if (!currentPassword || !newPassword) return [{ type: "message", messageType: "error", value: "Current and new password are required." }];
  const identifierField = identifierFieldOf(ctx.entity);
  const row = await getEntityRowByField(ctx.tx, ctx.applicationId, ctx.entity, identifierField, ctx.session.identity);
  if (!row) return [{ type: "message", messageType: "error", value: "Current password is incorrect." }];
  if (!row.passwordHash) {
    return [{ type: "message", messageType: "error", value: "This account doesn't have a password — it signs in with Google or GitHub." }];
  }
  if (!verifyPassword(currentPassword, String(row.passwordHash))) {
    return [{ type: "message", messageType: "error", value: "Current password is incorrect." }];
  }
  const role = hasRoleIdField(ctx.entity) ? await resolveAccountRole(ctx, row.roleId) : null;
  try {
    // Write through the full save pipeline with the WHOLE current row (not just passwordHash) —
    // saveEntityRow's required-field check runs over every one of the entity's own fields.
    await saveEntityRow(ctx.tx, ctx.applicationId, ctx.entity, ctx.relationships, ctx.validations, ctx.auditing, {
      ...row, passwordHash: hashPassword(newPassword), mustChangePassword: false,
    }, { identity: ctx.session.identity });
  } catch (e) {
    if (e instanceof ConcurrencyError) return [{ type: "message", messageType: "conflict", value: e.message }];
    if (e instanceof ValidationError) return [{ type: "message", messageType: "error", value: e.message }];
    throw e;
  }
  return [
    { type: "message", messageType: "success", value: "Password changed." },
    { type: "session", identity: ctx.session.identity, mustChangePassword: false, role },
  ];
}

// Confirms a registration's 6-digit email OTP, flips emailVerified, and — unlike register itself —
// logs the user straight in (verification IS the gate; once passed there's no reason to make them
// log in a second time).
async function runVerifyEmail(ctx: ActionRunContext, fieldValues: Record<string, unknown>): Promise<RuntimeAction[]> {
  if (!ctx.entity.isAccount) throw new Error(`verifyEmail can only run against the isAccount entity, not "${ctx.entity.name}"`);
  if (!hasField(ctx.entity, "email")) throw new Error(`verifyEmail requires the entity to have an "email" field`);
  const email = String(fieldValues.email ?? "").trim();
  const otpCode = String(fieldValues.otpCode ?? "").trim();
  if (!email || !otpCode) return [{ type: "message", messageType: "error", value: "Email and code are required." }];
  const row = await getEntityRowByField(ctx.tx, ctx.applicationId, ctx.entity, "email", email);
  if (!row) return [{ type: "message", messageType: "error", value: "Invalid or expired code." }];
  const result = await consumeEntityOtp(ctx.tx, ctx.applicationId, ctx.entity, row.id, "verifyEmail", otpCode);
  if (!result.ok) return [{ type: "message", messageType: "error", value: "Invalid or expired code." }];
  try {
    await saveEntityRow(ctx.tx, ctx.applicationId, ctx.entity, ctx.relationships, ctx.validations, ctx.auditing, {
      ...row, emailVerified: true,
    }, { identity: email });
  } catch (e) {
    if (e instanceof ConcurrencyError) return [{ type: "message", messageType: "conflict", value: e.message }];
    if (e instanceof ValidationError) return [{ type: "message", messageType: "error", value: e.message }];
    throw e;
  }
  const role = hasRoleIdField(ctx.entity) ? await resolveAccountRole(ctx, row.roleId) : null;
  return [
    { type: "message", messageType: "success", value: "Email verified!" },
    { type: "session", identity: email, mustChangePassword: row.mustChangePassword === true, role },
  ];
}

// Deliberately enumeration-safe: the SAME generic message comes back whether or not the email is
// registered (or is an OAuth-only account with no password to reset) — only the code-generation/
// email-sending actually happens when there's something real to act on.
async function runRequestPasswordReset(ctx: ActionRunContext, fieldValues: Record<string, unknown>): Promise<RuntimeAction[]> {
  if (!ctx.entity.isAccount) throw new Error(`requestPasswordReset can only run against the isAccount entity, not "${ctx.entity.name}"`);
  if (!hasField(ctx.entity, "email")) throw new Error(`requestPasswordReset requires the entity to have an "email" field`);
  const generic: RuntimeAction[] = [{ type: "message", messageType: "success", value: "If that email is registered, a reset code has been sent." }];
  const email = String(fieldValues.email ?? "").trim();
  if (!email) return generic;
  const row = await getEntityRowByField(ctx.tx, ctx.applicationId, ctx.entity, "email", email);
  if (!row || !row.passwordHash) return generic;
  const code = generateOtpCode();
  await setEntityOtp(ctx.tx, ctx.applicationId, ctx.entity, row.id, "resetPassword", code, 10);
  return [...generic, { type: "sendEmail", to: email, subject: "Reset your password", body: `Your password reset code is ${code}. It expires in 10 minutes.` }];
}

async function runResetPassword(ctx: ActionRunContext, fieldValues: Record<string, unknown>): Promise<RuntimeAction[]> {
  if (!ctx.entity.isAccount) throw new Error(`resetPassword can only run against the isAccount entity, not "${ctx.entity.name}"`);
  if (!hasField(ctx.entity, "email")) throw new Error(`resetPassword requires the entity to have an "email" field`);
  const email = String(fieldValues.email ?? "").trim();
  const otpCode = String(fieldValues.otpCode ?? "").trim();
  const newPassword = String(fieldValues.newPassword ?? "");
  if (!email || !otpCode || !newPassword) return [{ type: "message", messageType: "error", value: "Email, code, and new password are required." }];
  const row = await getEntityRowByField(ctx.tx, ctx.applicationId, ctx.entity, "email", email);
  if (!row) return [{ type: "message", messageType: "error", value: "Invalid or expired code." }];
  const result = await consumeEntityOtp(ctx.tx, ctx.applicationId, ctx.entity, row.id, "resetPassword", otpCode);
  if (!result.ok) return [{ type: "message", messageType: "error", value: "Invalid or expired code." }];
  try {
    await saveEntityRow(ctx.tx, ctx.applicationId, ctx.entity, ctx.relationships, ctx.validations, ctx.auditing, {
      ...row, passwordHash: hashPassword(newPassword), mustChangePassword: false,
    }, { identity: email });
  } catch (e) {
    if (e instanceof ConcurrencyError) return [{ type: "message", messageType: "conflict", value: e.message }];
    if (e instanceof ValidationError) return [{ type: "message", messageType: "error", value: e.message }];
    throw e;
  }
  return [{ type: "message", messageType: "success", value: "Password reset — you can now log in." }];
}

// Verifies the Google ID token the frontend's GoogleLogin component hands back (NOT reused from
// authService.ts — that version targets the Studio's own Postgres users table; this one targets
// the generated app's own Neo4j User entity) and finds-or-creates the row by email.
async function runGoogleLogin(ctx: ActionRunContext, fieldValues: Record<string, unknown>): Promise<RuntimeAction[]> {
  if (!ctx.entity.isAccount) throw new Error(`googleLogin can only run against the isAccount entity, not "${ctx.entity.name}"`);
  if (!hasField(ctx.entity, "email")) return [{ type: "message", messageType: "error", value: "This application's account entity doesn't support Google sign-in." }];
  if (!googleJwks || !GOOGLE_CLIENT_ID) return [{ type: "message", messageType: "error", value: "Google sign-in is not configured." }];
  const credential = String(fieldValues.credential ?? "");
  if (!credential) return [{ type: "message", messageType: "error", value: "Missing Google credential." }];
  let email: string, firstName: string, lastName: string;
  try {
    const { payload } = await jwtVerify(credential, googleJwks, {
      audience: GOOGLE_CLIENT_ID,
      issuer: ["https://accounts.google.com", "accounts.google.com"],
    });
    email = String(payload.email ?? "");
    firstName = String(payload.given_name ?? payload.name ?? "");
    lastName = String(payload.family_name ?? "");
  } catch {
    return [{ type: "message", messageType: "error", value: "Invalid Google credential." }];
  }
  if (!email) return [{ type: "message", messageType: "error", value: "Your Google account has no email address." }];
  const row = await findOrCreateOAuthRow(ctx, email, firstName, lastName, "google");
  const role = hasRoleIdField(ctx.entity) ? await resolveAccountRole(ctx, row.roleId) : null;
  return [
    { type: "message", messageType: "success", value: "Logged in with Google." },
    { type: "session", identity: email, mustChangePassword: false, role },
  ];
}

// Code-exchange flow adapted from authService.ts's exchangeGithubCode/githubLogin (same provider
// calls, new target: the generated app's own User entity instead of the Studio's Postgres table).
async function runGithubLogin(ctx: ActionRunContext, fieldValues: Record<string, unknown>): Promise<RuntimeAction[]> {
  if (!ctx.entity.isAccount) throw new Error(`githubLogin can only run against the isAccount entity, not "${ctx.entity.name}"`);
  if (!hasField(ctx.entity, "email")) return [{ type: "message", messageType: "error", value: "This application's account entity doesn't support GitHub sign-in." }];
  if (!GITHUB_CLIENT_ID || !GITHUB_CLIENT_SECRET) return [{ type: "message", messageType: "error", value: "GitHub sign-in is not configured." }];
  const code = String(fieldValues.code ?? "");
  const redirectUri = fieldValues.redirectUri ? String(fieldValues.redirectUri) : undefined;
  if (!code) return [{ type: "message", messageType: "error", value: "Missing GitHub code." }];

  const tokenResp = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: GITHUB_CLIENT_ID, client_secret: GITHUB_CLIENT_SECRET, code, ...(redirectUri ? { redirect_uri: redirectUri } : {}) }),
  });
  if (!tokenResp.ok) return [{ type: "message", messageType: "error", value: "GitHub sign-in failed." }];
  const tokenData = (await tokenResp.json()) as { access_token?: string };
  if (!tokenData.access_token) return [{ type: "message", messageType: "error", value: "GitHub sign-in failed." }];

  const userResp = await fetch("https://api.github.com/user", {
    headers: { Authorization: `Bearer ${tokenData.access_token}`, Accept: "application/vnd.github+json" },
  });
  if (!userResp.ok) return [{ type: "message", messageType: "error", value: "Failed to fetch GitHub profile." }];
  const githubUser = (await userResp.json()) as { email?: string; name?: string; login?: string };

  let email = githubUser.email;
  if (!email) {
    const emailsResp = await fetch("https://api.github.com/user/emails", {
      headers: { Authorization: `Bearer ${tokenData.access_token}`, Accept: "application/vnd.github+json" },
    });
    if (emailsResp.ok) {
      const emails = (await emailsResp.json()) as { email: string; primary: boolean; verified: boolean }[];
      email = emails.find((e) => e.primary && e.verified)?.email ?? emails.find((e) => e.verified)?.email;
    }
  }
  if (!email) return [{ type: "message", messageType: "error", value: "Your GitHub account has no verified email address." }];

  const fullName = githubUser.name || githubUser.login || "";
  const [firstName, ...rest] = fullName.split(" ");
  const lastName = rest.join(" ");
  const row = await findOrCreateOAuthRow(ctx, email, firstName || "", lastName || "", "github");
  const role = hasRoleIdField(ctx.entity) ? await resolveAccountRole(ctx, row.roleId) : null;
  return [
    { type: "message", messageType: "success", value: "Logged in with GitHub." },
    { type: "session", identity: email, mustChangePassword: false, role },
  ];
}

async function runDelete(ctx: ActionRunContext, fieldValues: Record<string, unknown>): Promise<RuntimeAction[]> {
  const keyField = ctx.entity.fields.find((f) => f.key);
  if (!keyField) throw new Error(`Entity "${ctx.entity.name}" has no key field`);
  try {
    await deleteEntityRow(ctx.tx, ctx.applicationId, ctx.entity, ctx.relationships, fieldValues[keyField.name], { identity: ctx.session.identity });
    return [{ type: "message", messageType: "success", value: "Deleted successfully." }];
  } catch (e) {
    if (e instanceof ValidationError) return [{ type: "message", messageType: "error", value: e.message }];
    throw e;
  }
}

// Walks a named Action's Steps in order. A failed Save step stops the rest of the steps (same
// reasoning the old engine's <when><message/><stop/></when> pattern already follows: don't run
// Notify after a save that didn't actually happen).
export async function runAction(ctx: ActionRunContext, action: ActionDef, fieldValues: Record<string, unknown>): Promise<RuntimeAction[]> {
  const values = { ...fieldValues };
  const results: RuntimeAction[] = [];
  for (const step of action.steps) {
    if (step.kind === "set") {
      const exprCtx: ExpressionContext = { fields: values, related: {}, session: ctx.session.vars };
      const resolved = evaluateExpression(step.value, exprCtx);
      values[step.field] = resolved;
      results.push({ type: "fieldUpdate", field: step.field, value: resolved });
    } else if (step.kind === "save") {
      const saveResults = await runSave(ctx, values);
      results.push(...saveResults);
      if (saveResults.some((r) => r.type === "message" && r.messageType === "error")) return results; // stop
    } else if (step.kind === "notify") {
      results.push({ type: "message", messageType: "info", value: substituteFieldTemplate(step.message, values) });
    }
  }
  return results;
}

const BUILTIN_ACTIONS = new Set([
  "save", "cancel", "delete", "openRecord", "login", "register", "changePassword",
  "verifyEmail", "requestPasswordReset", "resetPassword", "googleLogin", "githubLogin",
]);

export async function runButtonAction(
  ctx: ActionRunContext, actionName: string, actions: ActionDef[], fieldValues: Record<string, unknown>
): Promise<RuntimeAction[]> {
  if (actionName === "save") return runSave(ctx, fieldValues);
  if (actionName === "delete") return runDelete(ctx, fieldValues);
  if (actionName === "login") return runLogin(ctx, fieldValues);
  if (actionName === "register") return runRegister(ctx, fieldValues);
  if (actionName === "changePassword") return runChangePassword(ctx, fieldValues);
  if (actionName === "verifyEmail") return runVerifyEmail(ctx, fieldValues);
  if (actionName === "requestPasswordReset") return runRequestPasswordReset(ctx, fieldValues);
  if (actionName === "resetPassword") return runResetPassword(ctx, fieldValues);
  if (actionName === "googleLogin") return runGoogleLogin(ctx, fieldValues);
  if (actionName === "githubLogin") return runGithubLogin(ctx, fieldValues);
  if (actionName === "cancel" || actionName === "openRecord") return []; // no server-side effect; openRecord's navigation is resolved by the caller from Grid.onEvents
  if (BUILTIN_ACTIONS.has(actionName)) return []; // unreachable given the checks above, kept for exhaustiveness
  const action = actions.find((a) => a.name === actionName);
  if (!action) throw new Error(`Unknown action "${actionName}" — not a built-in and no matching <Action name="${actionName}"> was found`);
  return runAction(ctx, action, fieldValues);
}

export { substituteFieldTemplate };
