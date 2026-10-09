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

export function signAppSession(projectId: number): string {
  return jwt.sign({ typ: APP_SESSION_TYP, projectId }, SECRET_KEY, { algorithm: ALGORITHM, expiresIn: `${APP_SESSION_HOURS}h` });
}

// Verifies the token AND that it's really an app-session token (not a builder JWT someone tried to
// pass here) AND that it's for the project being asked about — returns null on any failure
// (expired, wrong project, tampered, wrong token type) rather than throwing, since "no valid
// session" is the normal/expected outcome for most requests, not an error.
export function verifyAppSession(token: string | undefined, projectId: number): boolean {
  if (!token) return false;
  try {
    const payload = jwt.verify(token, SECRET_KEY, { algorithms: [ALGORITHM] }) as jwt.JwtPayload;
    return payload.typ === APP_SESSION_TYP && Number(payload.projectId) === projectId;
  } catch {
    return false;
  }
}

export const APP_SESSION_COOKIE_OPTS = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: APP_SESSION_HOURS * 60 * 60,
};
