import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ProjectRow } from "../db/schema.js";
import { getCurrentUser, HttpError } from "../services/authService.js";
import { getOwnedProject, getProjectPublic } from "../services/projectStore.js";
import { parseScreenModel, ScreenParseError } from "../runtime/screenModel.js";
import { hasAnonymousEntry } from "../runtime/engine.js";
import { renderScreen } from "../runtime/renderer.js";
import { cookieName, verifyAppSession } from "../services/appSession.js";

type Screen = { id: string; name?: string; xml?: string };

function getScreens(project: ProjectRow): Screen[] {
  if (!project.uiScreens) return [];
  try {
    return JSON.parse(project.uiScreens);
  } catch {
    return [];
  }
}

function errorPage(status: number, message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Error</title>
<style>body{font-family:system-ui,sans-serif;padding:32px;color:#991b1b;background:#fef2f2}</style>
</head><body><h2>${status}</h2><p>${message.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</p></body></html>`;
}

// Server-side rendering entry point: a top-level browser navigation (an <iframe src=...>), which
// can't attach an Authorization header — auth comes from ?token=<JWT> instead, verified with the
// same getCurrentUser() every other route uses. Deliberately outside the /api prefix since this
// returns an HTML document, not JSON — errors render as a small HTML page (visible inside the
// iframe) rather than the app's usual JSON {detail} error shape.
export default async function runtimeRenderRoutes(app: FastifyInstance) {
  app.get(
    "/runtime/projects/:id/screens/:screenId",
    async (req: FastifyRequest<{ Params: { id: string; screenId: string }; Querystring: { token?: string } }>, reply) => {
      try {
        const projectId = Number(req.params.id);

        // Same dual authorization as run-event (see that route's comment for the full rationale):
        // (1) a builder token that owns this project — the Studio's own preview, unchanged; (2) a
        // real app session cookie for this exact project — a genuinely logged-in end user; (3)
        // neither, but the REQUESTED screen is a genuine public entry point (has an allowAnonymous
        // event — a Login/Signup screen) — renders with no identity, token baked in as "". Any
        // other screen, with neither (1) nor (2), is refused: its structure stays private even if
        // its id is guessed.
        let project: ProjectRow | null = null;
        let token = req.query.token || "";
        if (token) {
          try {
            const user = await getCurrentUser(token);
            project = await getOwnedProject(projectId, user.id);
          } catch {
            token = ""; // not a valid/owning builder token — fall through
          }
        }
        if (!project && verifyAppSession(req.cookies?.[cookieName(projectId)], projectId)) {
          project = await getProjectPublic(projectId);
        }

        const identified = Boolean(project);
        if (!project) project = await getProjectPublic(projectId); // to read the screen's XML below

        const allScreens = getScreens(project);
        const screen = allScreens.find((s) => s.id === req.params.screenId);
        if (!screen) throw new HttpError(404, "Screen not found");
        if (!screen.xml) throw new HttpError(400, "Screen has no XML yet");
        if (!identified && !hasAnonymousEntry(screen.xml)) throw new HttpError(401, "Please log in.");

        let model;
        try {
          model = parseScreenModel(screen.xml);
        } catch (e) {
          throw new HttpError(500, e instanceof ScreenParseError ? e.message : String(e));
        }

        // Prefer the Host header a proxy (Railway) sets over the raw socket's local port, so the
        // client script's fetch() calls hit the same public origin the browser actually navigated to.
        const proto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0] || req.protocol;
        const host = req.headers.host || `${req.hostname}:${req.socket.localPort}`;
        const apiBase = `${proto}://${host}`;
        const html = renderScreen(model, {
          apiBase, projectId: project.id, screenId: screen.id, token,
          appName: project.name, screens: allScreens.map((s) => ({ id: s.id, name: s.name || "" })),
          theme: project.uiTheme,
        });
        return reply.type("text/html; charset=utf-8").send(html);
      } catch (e) {
        const status = e instanceof HttpError ? e.status : 500;
        const message = e instanceof Error ? e.message : "Internal server error";
        if (!(e instanceof HttpError)) req.log.error(e, "runtime render failed");
        return reply.status(status).type("text/html; charset=utf-8").send(errorPage(status, message));
      }
    }
  );
}
