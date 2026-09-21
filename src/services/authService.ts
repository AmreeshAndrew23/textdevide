import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { users, type UserRow } from "../db/schema.js";
import {
  SECRET_KEY, ALGORITHM, ACCESS_TOKEN_EXPIRE_MINUTES,
  GOOGLE_CLIENT_ID, GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET,
} from "../config.js";

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function hashPassword(password: string): string {
  return bcrypt.hashSync(password, 10);
}

export function verifyPassword(plain: string, hashed: string): boolean {
  return bcrypt.compareSync(plain, hashed);
}

export function createAccessToken(data: Record<string, unknown>): string {
  return jwt.sign(data, SECRET_KEY, { algorithm: ALGORITHM, expiresIn: `${ACCESS_TOKEN_EXPIRE_MINUTES}m` });
}

export function decodeAccessToken(token: string): jwt.JwtPayload {
  try {
    return jwt.verify(token, SECRET_KEY, { algorithms: [ALGORITHM] }) as jwt.JwtPayload;
  } catch {
    throw new HttpError(401, "Invalid token");
  }
}

// Port of app/models/user.py's Column(default=...) values — SQLAlchemy applies these at INSERT
// time on the Python side (client-side, not a real DB column default; confirmed live: the actual
// Postgres `users.is_superuser`/`is_active` columns have column_default = null), so every new-user
// insert here must set them explicitly too, or they land NULL instead of the intended default.
const NEW_USER_DEFAULTS = { isActive: true, isSuperuser: false, dateFormat: "YYYY-MM-DD", language: "en" };

export async function registerUser(email: string, password: string, fullName?: string): Promise<UserRow> {
  const existing = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (existing.length > 0) throw new HttpError(400, "Email already registered");

  const [user] = await db
    .insert(users)
    .values({ email, hashedPassword: hashPassword(password), fullName, authProvider: "email", ...NEW_USER_DEFAULTS })
    .returning();
  return user;
}

export async function authenticateUser(email: string, password: string): Promise<UserRow> {
  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (!user || !user.hashedPassword || !verifyPassword(password, user.hashedPassword)) {
    throw new HttpError(401, "Invalid email or password");
  }
  return user;
}

async function exchangeGithubCode(code: string, redirectUri?: string): Promise<string> {
  if (!GITHUB_CLIENT_ID || !GITHUB_CLIENT_SECRET) {
    throw new HttpError(500, "GitHub OAuth is not configured");
  }
  const payload: Record<string, string> = { client_id: GITHUB_CLIENT_ID, client_secret: GITHUB_CLIENT_SECRET, code };
  if (redirectUri) payload.redirect_uri = redirectUri;

  const resp = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) throw new HttpError(401, "Invalid GitHub code or token exchange failed");
  const data = (await resp.json()) as { access_token?: string };
  if (!data.access_token) throw new HttpError(401, "Invalid GitHub code or token exchange failed");
  return data.access_token;
}

export async function githubLogin(code: string, redirectUri?: string): Promise<UserRow> {
  const token = await exchangeGithubCode(code, redirectUri);

  const userResp = await fetch("https://api.github.com/user", {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
  });
  if (!userResp.ok) throw new HttpError(401, "Failed to fetch GitHub profile");
  const githubUser = (await userResp.json()) as { email?: string; name?: string; login?: string; avatar_url?: string };

  let email = githubUser.email;
  if (!email) {
    const emailsResp = await fetch("https://api.github.com/user/emails", {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    });
    if (emailsResp.ok) {
      const emails = (await emailsResp.json()) as { email: string; primary: boolean; verified: boolean }[];
      email =
        emails.find((e) => e.primary && e.verified)?.email ??
        emails.find((e) => e.verified)?.email;
    }
  }
  if (!email) throw new HttpError(400, "GitHub account email is unavailable");

  const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (!existing) {
    const [user] = await db
      .insert(users)
      .values({
        email,
        fullName: githubUser.name || githubUser.login,
        picture: githubUser.avatar_url,
        authProvider: "github",
        githubToken: token,
        ...NEW_USER_DEFAULTS,
      })
      .returning();
    return user;
  }

  const [updated] = await db
    .update(users)
    .set({ githubToken: token, authProvider: !existing.authProvider || existing.authProvider === "email" ? "github" : existing.authProvider })
    .where(eq(users.id, existing.id))
    .returning();
  return updated;
}

const googleJwks = GOOGLE_CLIENT_ID ? createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs")) : null;

export async function googleLogin(credential: string): Promise<UserRow> {
  if (!googleJwks) throw new HttpError(500, "Google OAuth is not configured");
  let email: string, name: string | undefined, picture: string | undefined;
  try {
    const { payload } = await jwtVerify(credential, googleJwks, {
      audience: GOOGLE_CLIENT_ID,
      issuer: ["https://accounts.google.com", "accounts.google.com"],
    });
    email = payload.email as string;
    name = payload.name as string | undefined;
    picture = payload.picture as string | undefined;
  } catch (e) {
    throw new HttpError(401, `Invalid Google token: ${e instanceof Error ? e.message : e}`);
  }

  const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (existing) return existing;

  const [user] = await db
    .insert(users)
    .values({ email, fullName: name, picture, authProvider: "google", ...NEW_USER_DEFAULTS })
    .returning();
  return user;
}

export async function getCurrentUser(token: string): Promise<UserRow> {
  const payload = decodeAccessToken(token);
  const userId = payload.sub;
  if (!userId) throw new HttpError(401, "Invalid token");
  const [user] = await db.select().from(users).where(eq(users.id, Number(userId))).limit(1);
  if (!user) throw new HttpError(401, "User not found");
  return user;
}
