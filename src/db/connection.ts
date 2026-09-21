import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { DATABASE_URL } from "../config.js";
import * as schema from "./schema.js";

export const pool = new pg.Pool({ connectionString: DATABASE_URL });
export const db = drizzle(pool, { schema });

// A raw pg.PoolClient wrapped in BEGIN/COMMIT/ROLLBACK — used by previewDbService's functions,
// which take a PoolClient directly (mirroring the Python original's `conn: AsyncSession` param),
// rather than going through Drizzle's own query builder.
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
