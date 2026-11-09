/**
 * Live numbering for <Field autoNumber="..."> — e.g. PO-2026-000012. The counter lives in Neo4j
 * and is advanced inside the same transaction as the record it numbers, so a save that rolls back
 * doesn't burn a number and two saves can't get the same one (SET takes a write lock).
 */
import type { Transaction } from "neo4j-driver";
import { parseAutoNumberElement, type AutoNumberDef, type EntityDef } from "./applicationModel.js";
import { fromDriverValue, toDriverValue } from "../runtime/values.js";

export type AutoNumbers = Record<string, AutoNumberDef>;

export function autoNumbersOf(elements: { tag: string; xml: string }[]): AutoNumbers {
  return Object.fromEntries(elements.filter((e) => e.tag === "AutoNumber").map((e) => parseAutoNumberElement(e.xml)).map((d) => [d.id, d]));
}

export function formatAutoNumber(def: AutoNumberDef, value: number, now: Date): string {
  const prefix = def.prefix
    .replace(/\{YYYY\}/g, String(now.getFullYear()))
    .replace(/\{YY\}/g, String(now.getFullYear()).slice(-2))
    .replace(/\{MM\}/g, String(now.getMonth() + 1).padStart(2, "0"));
  return `${prefix}${String(value).padStart(def.padLength, "0")}`;
}

export async function nextAutoNumber(tx: Transaction, applicationId: number, def: AutoNumberDef, now = new Date()): Promise<string> {
  const period = def.reset === "yearly" ? String(now.getFullYear()) : "all";
  const res = await tx.run(
    "MERGE (c:RtAutoNumber {applicationId: $app, id: $id, period: $period}) " +
      "ON CREATE SET c.value = $start - $inc SET c.value = c.value + $inc RETURN c.value AS value",
    { app: toDriverValue(applicationId), id: def.id, period, start: toDriverValue(def.start), inc: toDriverValue(def.increment) }
  );
  return formatAutoNumber(def, Number(fromDriverValue(res.records[0].get("value"))), now);
}

// Fields numbered by a definition that actually exists.
export function numberedFields(entity: EntityDef, autoNumbers: AutoNumbers | undefined) {
  return autoNumbers ? entity.fields.filter((f) => f.autoNumber && autoNumbers[f.autoNumber]) : [];
}
