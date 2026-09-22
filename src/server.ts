import Fastify from "fastify";
import cors from "@fastify/cors";
import { ZodError } from "zod";
import { HttpError } from "./services/authService.js";
import authRoutes from "./routes/auth.js";
import projectRoutes from "./routes/projects.js";
import projectsAiRoutes from "./routes/projectsAi.js";
import screensRoutes from "./routes/screens.js";
import previewDbRoutes from "./routes/previewDb.js";
import adminRoutes from "./routes/admin.js";
import generateRoutes from "./routes/generate.js";
import runtimeRenderRoutes from "./routes/runtimeRender.js";
export async function buildServer() {
  const app = Fastify({ logger: true });

  // @fastify/cors defaults `methods` to the CORS-safelisted set (GET, HEAD, POST) — everything
  // else this API uses (PUT, DELETE) was silently blocked by the browser's preflight check before
  // ever reaching a route handler. Every verb the API actually serves must be listed explicitly.
  await app.register(cors, { origin: true, methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] });

  app.get("/api/health", async () => ({ status: "ok" }));

  await app.register(authRoutes, { prefix: "/api" });
  await app.register(projectRoutes, { prefix: "/api" });
  await app.register(projectsAiRoutes, { prefix: "/api" });
  await app.register(screensRoutes, { prefix: "/api" });
  await app.register(previewDbRoutes, { prefix: "/api" });
  await app.register(adminRoutes, { prefix: "/api" });
  await app.register(generateRoutes, { prefix: "/api" });
  await app.register(runtimeRenderRoutes);

  // Central error handler — mirrors FastAPI's HTTPException(status_code, detail) JSON shape so
  // the untouched React frontend's `err.response?.data?.detail` error-handling keeps working.
  app.setErrorHandler((err: unknown, _req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ detail: err.message });
    if (err instanceof ZodError) return reply.status(422).send({ detail: err.issues });
    const message = err instanceof Error ? err.message : "Internal server error";
    app.log.error(err);
    return reply.status(500).send({ detail: message });
  });

  return app;
}
