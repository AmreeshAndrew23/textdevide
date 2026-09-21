import "dotenv/config";

function normalizeDatabaseUrl(raw: string): string {
  // Mirrors app/config.py's normalization — Railway/other hosts may inject postgres:// or
  // postgresql+asyncpg:// (a SQLAlchemy-specific scheme); the `pg` driver needs plain postgresql://.
  if (raw.startsWith("postgresql+asyncpg://")) return raw.replace("postgresql+asyncpg://", "postgresql://");
  if (raw.startsWith("postgres://")) return raw.replace("postgres://", "postgresql://");
  return raw;
}

export const PORT = Number(process.env.PORT || 8001);

export const SECRET_KEY = process.env.SECRET_KEY || "dev-secret-key-change-in-production";
export const ALGORITHM = "HS256";
export const ACCESS_TOKEN_EXPIRE_MINUTES = 60 * 24;

export const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
export const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";

export const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || "";
export const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || "";

export const DATABASE_URL = normalizeDatabaseUrl(
  process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/textdevide"
);

export const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

// Comma-separated emails that get is_superuser=true auto-granted on every startup — grant-only,
// never auto-revokes, so a blank/misconfigured env var never demotes anyone.
export const SUPERUSER_EMAILS = (process.env.SUPERUSER_EMAILS || "")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

export const NEO4J_URI = process.env.NEO4J_URI || "";
export const NEO4J_USERNAME = process.env.NEO4J_USERNAME || "";
export const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD || "";
export const NEO4J_DATABASE = process.env.NEO4J_DATABASE || "neo4j";
