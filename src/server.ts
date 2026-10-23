import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import { ZodError } from "zod";
import { MAX_UPLOAD_BYTES } from "./runtimeEngine/uploads.js";
import { HttpError } from "./services/authService.js";
import authRoutes from "./routes/auth.js";
// Old engine — retired, see runtimeEngine/ (kept, not deleted, in case of rollback).
// import projectRoutes from "./routes/projects.js";
// import projectsAiRoutes from "./routes/projectsAi.js";
// import screensRoutes from "./routes/screens.js";
// import previewDbRoutes from "./routes/previewDb.js";
import adminRoutes from "./routes/admin.js";
// import generateRoutes from "./routes/generate.js";
// import runtimeRenderRoutes from "./routes/runtimeRender.js";
// import themePreviewRoutes from "./routes/themePreview.js";
import domainRoutes from "./routes/domains.js";
import runtimeApplicationRoutes, { runtimeUploadsPublicRoutes } from "./routes/runtimeApplications.js";
export async function buildServer() {
  const app = Fastify({ logger: true });

  // @fastify/cors defaults `methods` to the CORS-safelisted set (GET, HEAD, POST) — everything
  // else this API uses (PUT, DELETE) was silently blocked by the browser's preflight check before
  // ever reaching a route handler. Every verb the API actually serves must be listed explicitly.
  // credentials: true (+ the frontend's axios withCredentials) is what lets the browser actually
  // send/receive the runtimeEngine/appAuth.ts per-application session cookie — `origin: true`
  // reflects the request's own origin rather than "*", which is required for this to be allowed.
  await app.register(cors, { origin: true, credentials: true, methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] });
  // The generated app's own session cookie (see runtimeEngine/appAuth.ts, and the now-retired old
  // engine's services/appSession.ts) — set/read by the run route. No signing option passed: each
  // of those modules signs/verifies its own JWT, this plugin only parses/serializes the headers.
  await app.register(cookie);
  // Picture uploads for an isAccount/entity "image" field — see runtimeEngine/uploads.ts. The
  // byte limit here is the HARD stop (a request over it is rejected before any handler even
  // runs); uploads.ts's own check is the one that actually fires for a real oversized file.
  await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES } });

  app.get("/api/health", async () => ({ status: "ok" }));

  await app.register(authRoutes, { prefix: "/api" });
  // Old engine — retired, see runtimeEngine/ (kept, not deleted, in case of rollback).
  // await app.register(projectRoutes, { prefix: "/api" });
  await app.register(domainRoutes, { prefix: "/api" });
  await app.register(runtimeApplicationRoutes, { prefix: "/api" });
  await app.register(runtimeUploadsPublicRoutes, { prefix: "/api" }); // no requireAuth — see its own comment
  // await app.register(projectsAiRoutes, { prefix: "/api" });
  // await app.register(screensRoutes, { prefix: "/api" });
  // await app.register(previewDbRoutes, { prefix: "/api" });
  await app.register(adminRoutes, { prefix: "/api" });
  // await app.register(generateRoutes, { prefix: "/api" });
  // await app.register(runtimeRenderRoutes);
  // await app.register(themePreviewRoutes);

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
