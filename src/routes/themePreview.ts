import type { FastifyInstance, FastifyRequest } from "fastify";
import { parseScreenModel } from "../runtime/screenModel.js";
import { renderScreen } from "../runtime/renderer.js";

// A small fixed demo screen — enough to show off the header band, nav, a form card, a grid card,
// and a button — used ONLY to preview what a theme looks like, never tied to any real project.
const SAMPLE_SCREEN_XML = `<screen id="sample" title="Sample Screen">
  <dataSources><dataSource id="mainDB" type="database"/></dataSources>
  <queries></queries>
  <ui>
    <field id="name" label="Customer Name" type="text"><rule required="true"/></field>
    <field id="email" label="Email Address" type="email"/>
    <grid id="orders" label="Recent Orders" emptyMessage="No orders yet">
      <column id="id" header="Order ID" binding="id"/>
      <column id="total" header="Total" binding="total"/>
    </grid>
    <button id="save" label="Save" style="primary"/>
    <button id="cancel" label="Cancel" style="secondary"/>
  </ui>
  <events></events>
</screen>`;
const SAMPLE_MODEL = parseScreenModel(SAMPLE_SCREEN_XML);

// Unauthenticated on purpose: fixed, non-sensitive sample content, not real project data — a theme
// picker shown before a project even exists (project creation) needs this reachable with no token.
export default async function themePreviewRoutes(app: FastifyInstance) {
  app.get("/runtime/theme-preview/:theme", async (req: FastifyRequest<{ Params: { theme: string } }>, reply) => {
    const proto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0] || req.protocol;
    const host = req.headers.host || `${req.hostname}:${req.socket.localPort}`;
    const apiBase = `${proto}://${host}`;
    const html = renderScreen(SAMPLE_MODEL, {
      apiBase, projectId: 0, screenId: "sample", token: "",
      appName: "Your App", screens: [{ id: "sample", name: "Sample Screen" }],
      theme: req.params.theme,
    });
    return reply.type("text/html; charset=utf-8").send(html);
  });
}
