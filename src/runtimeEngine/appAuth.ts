/**
 * A generated Application's own real end-user login session — scoped to ONE applicationId,
 * completely separate from both the Studio builder's JWT (services/authService.ts) and the OLD
 * engine's per-project session (services/appSession.ts, now retired alongside the rest of the old
 * engine). Deliberately its own cookie name prefix and JWT `typ`, even though the shape mirrors
 * appSession.ts closely, so a stale old-engine cookie (or a Studio builder token) can never be
 * mistaken for one of these — and so a `runtime_applications.id` can never collide with an old
 * `projects.id` that happens to share the same number.
 */
import jwt from "jsonwebtoken";
import { SECRET_KEY, ALGORITHM } from "../config.js";

const RT_APP_SESSION_HOURS = 12;
const RT_APP_SESSION_TYP = "rtAppSession";

export function rtAppCookieName(applicationId: number): string {
  return `td_rtapp_session_${applicationId}`;
}

// identity is the logged-in account's own username (the User entity's own "username" field) —
// opaque to this module, just carried for the runtime to stamp auditing/session-identity with.
// mustChangePassword mirrors appSession.ts's same flag: while true, only the ChangePassword
// screen's changePassword action should succeed (enforced where the session is consumed). role is
// optional — only present for an app using the roleId/requiresRole RBAC convention (see
// applicationEngine.ts's runLogin); resolved once at login time and carried in the signed token so
// every later request doesn't need to re-walk the User->AccessRole relationship.
export function signRtAppSession(applicationId: number, identity: string, mustChangePassword: boolean, role?: string | null): string {
  return jwt.sign(
    { typ: RT_APP_SESSION_TYP, applicationId, identity, mustChangePassword, role: role ?? null },
    SECRET_KEY, { algorithm: ALGORITHM, expiresIn: `${RT_APP_SESSION_HOURS}h` }
  );
}

export type VerifiedRtAppSession = { identity: string; mustChangePassword: boolean; role: string | null };

// Returns null on any failure (expired, wrong application, tampered, wrong token type) rather
// than throwing — "no valid session" is the normal outcome for most requests, not an error.
export function verifyRtAppSession(token: string | undefined, applicationId: number): VerifiedRtAppSession | null {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, SECRET_KEY, { algorithms: [ALGORITHM] }) as jwt.JwtPayload;
    if (payload.typ !== RT_APP_SESSION_TYP || Number(payload.applicationId) !== applicationId) return null;
    if (typeof payload.identity !== "string") return null;
    return {
      identity: payload.identity, mustChangePassword: payload.mustChangePassword === true,
      role: typeof payload.role === "string" ? payload.role : null,
    };
  } catch {
    return null;
  }
}

export const RT_APP_SESSION_COOKIE_OPTS = {
  httpOnly: true,
  // "strict" over "lax": this cookie is only ever read by same-origin fetch/XHR from the Run
  // panel — never needed for a cross-site top-level navigation GET — so there's no real downside,
  // and it closes off a small CSRF surface "lax" still leaves open.
  sameSite: "strict" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: RT_APP_SESSION_HOURS * 60 * 60,
};
