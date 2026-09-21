import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { promptLogs, projects, users } from "../db/schema.js";
import { getCurrentUser, HttpError } from "../services/authService.js";

// Port of routes/admin.py's token-usage view — $ per 1,000,000 tokens, OpenAI's published rates
// for the models this app actually calls. Priced at read time from the stored `model` name
// (never a snapshotted price), so historical rows stay accurate even if these constants change
// later. An unrecognized/null model falls back to the gpt-4o-mini rate, this app's default model.
const PRICING: Record<string, { input: number; output: number }> = {
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4o": { input: 2.5, output: 10.0 },
};
const DEFAULT_PRICING = PRICING["gpt-4o-mini"];

const SCHEMA_KINDS = new Set(["extract_entities", "refine_entities", "schema_assistant"]);
const UI_KINDS = new Set([
  "screen_generate_xml", "screen_generate_html", "screen_generate_html_variants",
  "screen_generate_api", "screen_refine_ui", "workbench_screen_xml", "workbench_screen_html",
]);

function bucketFor(kind: string): "schema" | "ui" | "other" {
  if (SCHEMA_KINDS.has(kind)) return "schema";
  if (UI_KINDS.has(kind)) return "ui";
  return "other";
}

function cost(model: string | null, promptTokens: number, completionTokens: number): number {
  const rates = (model && PRICING[model]) || DEFAULT_PRICING;
  return (promptTokens / 1_000_000) * rates.input + (completionTokens / 1_000_000) * rates.output;
}

type BucketUsage = { prompt_tokens: number; completion_tokens: number; total_tokens: number; cost_usd: number; call_count: number };
function emptyBucket(): BucketUsage {
  return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost_usd: 0, call_count: 0 };
}

async function requireSuperuser(req: FastifyRequest, _reply: FastifyReply) {
  const authorization = req.headers.authorization || "";
  const token = authorization.replace("Bearer ", "");
  const user = await getCurrentUser(token);
  if (!user.isSuperuser) throw new HttpError(403, "Superuser access required");
  req.user = user;
}

export default async function adminRoutes(app: FastifyInstance) {
  app.get("/admin/token-usage", { preHandler: requireSuperuser }, async (_req, reply) => {
    const rows = await db
      .select({
        userId: users.id, email: users.email, fullName: users.fullName,
        projectId: projects.id, projectName: projects.name,
        kind: promptLogs.kind, model: promptLogs.model,
        promptTokens: promptLogs.promptTokens, completionTokens: promptLogs.completionTokens, totalTokens: promptLogs.totalTokens,
      })
      .from(promptLogs)
      .innerJoin(projects, eq(projects.id, promptLogs.projectId))
      .innerJoin(users, eq(users.id, promptLogs.userId));

    type UserAgg = { email: string; fullName: string | null; projects: Map<number, { name: string; buckets: Map<string, BucketUsage> }> };
    const usersAgg = new Map<number, UserAgg>();

    for (const row of rows) {
      const promptTokens = row.promptTokens || 0;
      const completionTokens = row.completionTokens || 0;
      const totalTokens = row.totalTokens || 0;

      let u = usersAgg.get(row.userId);
      if (!u) {
        u = { email: row.email, fullName: row.fullName, projects: new Map() };
        usersAgg.set(row.userId, u);
      }
      let p = u.projects.get(row.projectId);
      if (!p) {
        p = { name: row.projectName, buckets: new Map() };
        u.projects.set(row.projectId, p);
      }
      const bucketKey = bucketFor(row.kind);
      let b = p.buckets.get(bucketKey);
      if (!b) {
        b = emptyBucket();
        p.buckets.set(bucketKey, b);
      }
      b.prompt_tokens += promptTokens;
      b.completion_tokens += completionTokens;
      b.total_tokens += totalTokens;
      b.call_count += 1;
      b.cost_usd += cost(row.model, promptTokens, completionTokens);
    }

    const resultUsers: any[] = [];
    let grandTotalTokens = 0;
    let grandTotalCost = 0;
    for (const [userId, u] of usersAgg) {
      const projectsOut: any[] = [];
      let userTotalTokens = 0;
      let userTotalCost = 0;
      for (const [projectId, p] of u.projects) {
        const schemaB = p.buckets.get("schema") || emptyBucket();
        const uiB = p.buckets.get("ui") || emptyBucket();
        const otherB = p.buckets.get("other") || emptyBucket();
        const projTokens = schemaB.total_tokens + uiB.total_tokens + otherB.total_tokens;
        const projCost = schemaB.cost_usd + uiB.cost_usd + otherB.cost_usd;
        projectsOut.push({
          project_id: projectId, project_name: p.name,
          schema_usage: schemaB, ui_usage: uiB, other_usage: otherB,
          total_tokens: projTokens, total_cost_usd: Math.round(projCost * 10000) / 10000,
        });
        userTotalTokens += projTokens;
        userTotalCost += projCost;
      }
      projectsOut.sort((a, b) => b.total_tokens - a.total_tokens);
      resultUsers.push({
        user_id: userId, email: u.email, full_name: u.fullName,
        total_tokens: userTotalTokens, total_cost_usd: Math.round(userTotalCost * 10000) / 10000,
        projects: projectsOut,
      });
      grandTotalTokens += userTotalTokens;
      grandTotalCost += userTotalCost;
    }
    resultUsers.sort((a, b) => b.total_tokens - a.total_tokens);

    return reply.send({
      users: resultUsers,
      grand_total_tokens: grandTotalTokens,
      grand_total_cost_usd: Math.round(grandTotalCost * 10000) / 10000,
    });
  });
}
