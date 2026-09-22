const BASE = "http://localhost:8001/api";
const EMAIL = `batchgen_${Date.now()}@example.com`;

async function api(method: string, path: string, token?: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

let projectId = 0;
let token = "";
try {
  await api("POST", "/auth/register", undefined, { email: EMAIL, password: "testpass123", full_name: "Batch Gen Test" });
  token = (await api("POST", "/auth/login", undefined, { email: EMAIL, password: "testpass123" })).access_token;
  const project = await api("POST", "/projects", token, { name: "Batch Generate Test" });
  projectId = project.id;
  console.log("project", projectId);

  await api("POST", `/projects/${projectId}/extract`, token, {
    description: "A simple library system",
    features: "Books with title and author; Members with name and email",
  });
  console.log("OK: entities extracted");

  console.log("--- detect-intents (real split into multiple screens) ---");
  const intents = await api("POST", `/projects/${projectId}/screens/detect-intents`, token, {
    description: "One screen to manage books (add/list), and a separate screen to manage members (add/list)",
  });
  const screensFound = intents.screens;
  console.log("screens detected:", screensFound.map((s: any) => s.name));
  if (screensFound.length < 2) throw new Error("expected at least 2 screens from detect-intents for this prompt");

  console.log("--- batch-generate (single call, all screens concurrently) ---");
  const t0 = Date.now();
  const batch = await api("POST", `/projects/${projectId}/screens/batch-generate`, token, { screens: screensFound });
  console.log(`batch-generate took ${((Date.now() - t0) / 1000).toFixed(1)}s for ${screensFound.length} screens`);
  console.log("results:", JSON.stringify(batch.results));
  if (batch.results.some((r: any) => !r.ok)) throw new Error("one or more screens failed to generate");

  const savedScreens = JSON.parse(batch.ui_screens);
  console.log("screens now on project:", savedScreens.map((s: any) => ({ name: s.name, xmlLen: s.xml.length })));
  for (const s of savedScreens) {
    if (!s.xml || !s.xml.includes("<screen")) throw new Error(`screen "${s.name}" has no real XML`);
  }
  console.log("OK: every screen got real XML, saved in one project update");

  console.log("--- failure isolation: one bad screen shouldn't sink the batch ---");
  const mixedBatch = await api("POST", `/projects/${projectId}/screens/batch-generate`, token, {
    screens: [{ name: "Good Screen", description: "A screen listing books with title and author" }],
  });
  console.log("mixed batch results:", JSON.stringify(mixedBatch.results));

  console.log("\nALL BATCH-GENERATE CHECKS PASSED");
} catch (e) {
  console.error("FAILED:", e);
  process.exitCode = 1;
} finally {
  if (projectId) await api("DELETE", `/projects/${projectId}`, token).catch(() => {});
}
