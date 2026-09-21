import type { FastifyRequest, FastifyReply } from "fastify";
import { getCurrentUser } from "../services/authService.js";
import type { UserRow } from "../db/schema.js";

declare module "fastify" {
  interface FastifyRequest {
    user: UserRow;
  }
}

// Port of routes/projects.py's `_get_user` dependency — every protected route uses this as a
// preHandler instead of FastAPI's Depends(_get_user).
export async function requireAuth(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const authorization = req.headers.authorization || "";
  const token = authorization.replace("Bearer ", "");
  req.user = await getCurrentUser(token);
}
