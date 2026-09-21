import type { FastifyInstance } from "fastify";
import { GenerateFromTemplateRequestSchema } from "../models/schemas.js";
import { requireAuth } from "./authGuard.js";
import { generateUiXml, generateHtmlFromXml } from "../services/aiService.js";
import { HttpError } from "../services/authService.js";

// Port of routes/generate.py's standalone template-to-preview flow (ScreenGenerator.jsx) — no
// project/entities context, just a freeform template description straight to XML then HTML.
export default async function generateRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  app.post("/generate/from-template", async (req, reply) => {
    const body = GenerateFromTemplateRequestSchema.parse(req.body);
    let xml: string;
    try {
      xml = await generateUiXml(body.template, null);
    } catch (e) {
      throw new HttpError(500, `Screen generation failed: ${e instanceof Error ? e.message : e}`);
    }
    let html: string;
    try {
      html = await generateHtmlFromXml(xml, "HTML/CSS");
    } catch (e) {
      throw new HttpError(500, `Preview generation failed: ${e instanceof Error ? e.message : e}`);
    }
    return reply.send({ xml, html });
  });
}
