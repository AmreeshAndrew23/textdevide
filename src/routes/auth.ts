import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { users } from "../db/schema.js";
import {
  registerUser, authenticateUser, googleLogin, githubLogin,
  createAccessToken,
} from "../services/authService.js";
import { serializeUser } from "../serializers.js";
import {
  UserRegisterSchema, UserLoginSchema, GoogleTokenRequestSchema, GithubCodeRequestSchema, UserUpdateSchema,
} from "../models/schemas.js";
import { requireAuth } from "./authGuard.js";

// Allowed values for the Configuration screen dropdowns — port of routes/auth.py's constants.
const DATE_FORMATS = ["YYYY-MM-DD", "DD/MM/YYYY", "MM/DD/YYYY", "DD-MMM-YYYY", "DD.MM.YYYY"];
const LANGUAGES = [
  { code: "en", label: "English" },
  { code: "es", label: "Spanish" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
  { code: "hi", label: "Hindi" },
  { code: "ta", label: "Tamil" },
];

export default async function authRoutes(app: FastifyInstance) {
  app.post("/auth/register", async (req, reply) => {
    const body = UserRegisterSchema.parse(req.body);
    const user = await registerUser(body.email, body.password, body.full_name ?? undefined);
    const token = createAccessToken({ sub: String(user.id) });
    return reply.send({ access_token: token, token_type: "bearer", user: serializeUser(user) });
  });

  app.post("/auth/login", async (req, reply) => {
    const body = UserLoginSchema.parse(req.body);
    const user = await authenticateUser(body.email, body.password);
    const token = createAccessToken({ sub: String(user.id) });
    return reply.send({ access_token: token, token_type: "bearer", user: serializeUser(user) });
  });

  app.post("/auth/google", async (req, reply) => {
    const body = GoogleTokenRequestSchema.parse(req.body);
    const user = await googleLogin(body.credential);
    const token = createAccessToken({ sub: String(user.id) });
    return reply.send({ access_token: token, token_type: "bearer", user: serializeUser(user) });
  });

  app.post("/auth/github", async (req, reply) => {
    const body = GithubCodeRequestSchema.parse(req.body);
    const user = await githubLogin(body.code, body.redirect_uri ?? undefined);
    const token = createAccessToken({ sub: String(user.id) });
    return reply.send({ access_token: token, token_type: "bearer", user: serializeUser(user) });
  });

  app.get("/auth/me", { preHandler: requireAuth }, async (req, reply) => {
    return reply.send(serializeUser(req.user));
  });

  app.put("/auth/me", { preHandler: requireAuth }, async (req, reply) => {
    const body = UserUpdateSchema.parse(req.body);
    const update: Record<string, unknown> = {};
    if (body.full_name !== undefined) update.fullName = body.full_name;
    if (body.github_token !== undefined) update.githubToken = body.github_token;
    if (body.date_format !== undefined) update.dateFormat = body.date_format;
    if (body.language !== undefined) update.language = body.language;
    const [updated] = await db.update(users).set(update).where(eq(users.id, req.user.id)).returning();
    return reply.send(serializeUser(updated));
  });

  app.get("/auth/config/options", async (_req, reply) => {
    return reply.send({ date_formats: DATE_FORMATS, languages: LANGUAGES });
  });
}
