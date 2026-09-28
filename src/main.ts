import { buildServer } from "./server.js";
import { syncSchema, syncSuperusers } from "./db/sync.js";
import { PORT, NEO4J_URI } from "./config.js";
import { ensureWorkspaceSchema } from "./services/projectStore.js";

async function main() {
  await syncSchema();
  await syncSuperusers();
  // Not awaited: creating the workspace constraints must never delay or block startup.
  if (NEO4J_URI) void ensureWorkspaceSchema();

  const app = await buildServer();
  await app.listen({ port: PORT, host: "0.0.0.0" });
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
