import { db } from "../db/connection.js";
import { promptLogs } from "../db/schema.js";
import type { UsageEntry } from "./aiService.js";

// Port of routes/projects.py's _log_prompt/_usage_totals.
export function usageTotals(usageSink?: UsageEntry[]) {
  if (!usageSink || usageSink.length === 0) {
    return { model: undefined, promptTokens: undefined, completionTokens: undefined, totalTokens: undefined };
  }
  return {
    model: usageSink[usageSink.length - 1].model,
    promptTokens: usageSink.reduce((s, u) => s + u.prompt_tokens, 0),
    completionTokens: usageSink.reduce((s, u) => s + u.completion_tokens, 0),
    totalTokens: usageSink.reduce((s, u) => s + u.total_tokens, 0),
  };
}

export async function logPrompt(
  userId: number,
  projectId: number,
  kind: string,
  prompt: string,
  response: string,
  usageSink?: UsageEntry[]
) {
  const totals = usageTotals(usageSink);
  await db.insert(promptLogs).values({
    userId,
    projectId,
    kind,
    prompt,
    response,
    model: totals.model,
    promptTokens: totals.promptTokens,
    completionTokens: totals.completionTokens,
    totalTokens: totals.totalTokens,
  });
}
