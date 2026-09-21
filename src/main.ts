import { buildServer } from "./server.js";
import { syncSchema, syncSuperusers } from "./db/sync.js";
import { PORT } from "./config.js";

async function main() {
  await syncSchema();
  await syncSuperusers();

  const app = await buildServer();
  await app.listen({ port: PORT, host: "0.0.0.0" });
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
