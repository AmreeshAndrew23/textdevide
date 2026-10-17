import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ProjectRow } from "../db/schema.js";
import { getCurrentUser, HttpError } from "../services/authService.js";
import { getOwnedProject, getProjectPublic } from "../services/projectStore.js";
import { parseScreenModel, ScreenParseError } from "../runtime/screenModel.js";
import { hasAnonymousEntry, screenRequiredRole } from "../runtime/engine.js";
import { renderScreen } from "../runtime/renderer.js";
import { cookieName, verifyAppSession, APP_SESSION_COOKIE_OPTS } from "../services/appSession.js";

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
        // Resolved ONLY from the verified session cookie, never from anything client-submitted —
        // same anti-spoofing precedent as sessionIdentity. null for a builder preview (not a real
        // end-user session) or no session at all.
        let sessionRole: string | null = null;
        if (!project) {
          const session = verifyAppSession(req.cookies?.[cookieName(projectId)], projectId);
          if (session) {
            project = await getProjectPublic(projectId);
            sessionRole = session.role;
          }
        }

        const identified = Boolean(project);
        if (!project) project = await getProjectPublic(projectId); // to read the screen's XML below

        const allScreens = getScreens(project);
        const screen = allScreens.find((s) => s.id === req.params.screenId);
        if (!screen) throw new HttpError(404, "Screen not found");
        if (!screen.xml) throw new HttpError(400, "Screen has no XML yet");
        if (!identified && !hasAnonymousEntry(screen.xml)) throw new HttpError(401, "Please log in.");

        // The builder's own Studio preview (a real, project-owning token) always has full access —
        // same bypass allowAnonymous/session concerns already get. A real end-user session must have
        // a role in the screen's requiredRole list, if one is declared.
        const isBuilderPreview = Boolean(token);
        const required = screenRequiredRole(screen.xml);
        if (required && !isBuilderPreview && (!sessionRole || !required.includes(sessionRole))) {
          throw new HttpError(403, "You don't have permission to view this screen.");
        }

        let model;
        try {
          model = parseScreenModel(screen.xml);
        } catch (e) {
          throw new HttpError(500, e instanceof ScreenParseError ? e.message : String(e));
        }

        // A real app session (not the builder's own Studio preview, not an anonymous entry render)
        // gets the shell's built-in "Log out" control, pointed at a real sibling login screen if the
        // project has one — and a "Profile" link too, if the project has a screen by that name
        // (zero AI wiring needed for either; both are purely structural, same pattern).
        const loggedIn = identified && !token;
        const loginScreen =
          allScreens.find((s) => s.xml && hasAnonymousEntry(s.xml) && /\blogin\b/i.test(s.name || "")) ||
          allScreens.find((s) => s.xml && hasAnonymousEntry(s.xml));
        const profileScreen = allScreens.find((s) => s.xml && /\bprofile\b/i.test(s.name || ""));

        // Real application, not a bundle of jump-anywhere pages: before logging in, the nav shows
        // ONLY the other genuine entry points (Login/Signup/Forgot Password), never the whole app —
        // same reasoning hasAnonymousEntry already applies to which screens even render at all.
        // Once logged in, the full nav returns (identical to the Studio's own preview) MINUS
        // Profile, which already gets its own dedicated spot next to Log out — the same way a real
        // app keeps account actions out of the main nav.
        const navScreens = (identified ? allScreens : allScreens.filter((s) => s.xml && hasAnonymousEntry(s.xml)))
          .filter((s) => s.id !== profileScreen?.id);

        // Prefer the Host header a proxy (Railway) sets over the raw socket's local port, so the
        // client script's fetch() calls hit the same public origin the browser actually navigated to.
        const proto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0] || req.protocol;
        const host = req.headers.host || `${req.hostname}:${req.socket.localPort}`;
        const apiBase = `${proto}://${host}`;
        const html = renderScreen(model, {
          apiBase, projectId: project.id, screenId: screen.id, token,
          appName: project.name, screens: navScreens.map((s) => ({ id: s.id, name: s.name || "" })),
          theme: project.uiTheme, loggedIn, loginScreenId: loginScreen?.id ?? null, profileScreenId: profileScreen?.id ?? null,
          sessionRole,
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

  // The shell's built-in "Log out" control calls this — a plain session clear, no Cypher/engine
  // involvement at all (there's nothing to "run", just forget the session). Always succeeds: a
  // logout for a session that's already gone is a no-op, not an error.
  app.post("/runtime/projects/:id/logout", async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    reply.clearCookie(cookieName(Number(req.params.id)), { path: APP_SESSION_COOKIE_OPTS.path });
    return reply.status(204).send();
  });
}
