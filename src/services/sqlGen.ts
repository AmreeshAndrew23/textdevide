// Deterministic port of ai_service.generate_sql — pure entities-JSON -> SQL string, no LLM call.
type Column = { name: string; type?: string; pk?: boolean; fk?: string };
type Table = { name: string; columns?: Column[] };
type Entities = { tables?: Table[] };

const TYPE_MAP: Record<string, string> = {
  INT: "INTEGER",
  VARCHAR: "VARCHAR(255)",
  TEXT: "TEXT",
  BOOLEAN: "BOOLEAN",
  DECIMAL: "DECIMAL(10,2)",
  DATE: "DATE",
  TIMESTAMP: "TIMESTAMP DEFAULT CURRENT_TIMESTAMP",
};

export function generateSql(entities: Entities): string {
  const lines = ["-- Auto-generated SQL schema", "-- Created by Text Dev IDE", ""];
  const fkStatements: string[] = [];

  for (const table of entities.tables || []) {
    const name = table.name.toLowerCase();
    lines.push(`CREATE TABLE ${name} (`);
    const colLines: string[] = [];
    for (const col of table.columns || []) {
      const colName = col.name;
      const colType = col.type || "VARCHAR";
      const sqlType = TYPE_MAP[colType.toUpperCase()] || colType;
      if (col.pk) {
        colLines.push(`    ${colName} SERIAL PRIMARY KEY`);
      } else if (colName.endsWith("_id") || col.fk) {
        colLines.push(`    ${colName} INTEGER NOT NULL`);
      } else {
        colLines.push(`    ${colName} ${sqlType}`);
      }
      if (col.fk) {
        const [refTable, refCol] = col.fk.toLowerCase().split(".");
        fkStatements.push(
          `ALTER TABLE ${name} ADD CONSTRAINT fk_${name}_${colName} FOREIGN KEY (${colName}) REFERENCES ${refTable}(${refCol});`
        );
      }
    }
    lines.push(colLines.join(",\n"));
    lines.push(");\n");
  }

  if (fkStatements.length > 0) {
    lines.push("-- Foreign Key Constraints");
    lines.push(...fkStatements);
    lines.push("");
  }

  return lines.join("\n");
}
