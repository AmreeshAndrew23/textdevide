/**
 * The generated APP's own login session — completely separate from the Studio's builder JWT
 * (authService.ts). A builder's own token proves "I own this project in the Studio"; this proves
 * "a real end user logged into THIS project's own app" (its Login/Signup screen, its own Account
 * table). Deliberately a distinct signing path (own helper functions, same SECRET_KEY but never
 * interchangeable with createAccessToken/decodeAccessToken) so the two systems can never be
 * confused — a builder token is never accepted as an app session and vice versa.
 */
import jwt from "jsonwebtoken";
import { SECRET_KEY, ALGORITHM } from "../config.js";

const APP_SESSION_HOURS = 12;
const APP_SESSION_TYP = "appSession";

export function cookieName(projectId: number): string {
  return `td_session_${projectId}`;
}

// identity (optional) is WHICH account this session belongs to — e.g. the username a login/signup
// resolved <session action="start" identity="field:x"/> against (see engine.ts). Opaque to this
// module: just a string a generated screen's own queries later bind as source="session:identity"
// to act on "the current user's own row", never trusting a client-submitted value of the same name.
// role (optional) works the same way — resolved once at login/signup (<session ... role="result:role"/>)
// and trusted for the session's lifetime; a role change takes effect on next login, not instantly,
// the same staleness tradeoff already accepted for identity. Bound later as source="session:role"
// and as the session:role condition token (see engine.ts), never from client-submitted fieldValues.
// mustChangePassword (optional, default false) marks a session issued with a temporary password —
// while true, the runtime refuses every event/screen except one marked allowPasswordChange="true"
// (see engine.ts/previewDb.ts/runtimeRender.ts), the same way an unauthenticated session can only
// reach an allowAnonymous one. A successful change re-issues the session with it cleared.
export function signAppSession(
  projectId: number, identity?: string | null, role?: string | null, mustChangePassword?: boolean
): string {
  return jwt.sign(
    { typ: APP_SESSION_TYP, projectId, identity: identity ?? null, role: role ?? null, mustChangePassword: mustChangePassword ?? false },
    SECRET_KEY, { algorithm: ALGORITHM, expiresIn: `${APP_SESSION_HOURS}h` }
  );
}

export type VerifiedAppSession = { identity: string | null; role: string | null; mustChangePassword: boolean };

// Verifies the token AND that it's really an app-session token (not a builder JWT someone tried to
// pass here) AND that it's for the project being asked about — returns null on any failure
// (expired, wrong project, tampered, wrong token type) rather than throwing, since "no valid
// session" is the normal/expected outcome for most requests, not an error.
export function verifyAppSession(token: string | undefined, projectId: number): VerifiedAppSession | null {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, SECRET_KEY, { algorithms: [ALGORITHM] }) as jwt.JwtPayload;
    if (payload.typ !== APP_SESSION_TYP || Number(payload.projectId) !== projectId) return null;
    return {
      identity: typeof payload.identity === "string" ? payload.identity : null,
      role: typeof payload.role === "string" ? payload.role : null,
      mustChangePassword: payload.mustChangePassword === true,
    };
  } catch {
    return null;
  }
}

export const APP_SESSION_COOKIE_OPTS = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: APP_SESSION_HOURS * 60 * 60,
};
