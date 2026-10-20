import { describe, expect, it } from "vitest";
import { entityLabelFor, prepareAppCypher } from "./labels.js";

describe("labels: entityLabelFor — a namespace that can never collide with the old engine's Proj<id>_<Table>", () => {
  it("never produces a bare Proj<id>_ label", () => {
    const label = entityLabelFor(7, "Vendor");
    expect(label).toBe("RtApp7_Vendor");
    expect(label.startsWith("Proj")).toBe(false);
  });
  it("sanitizes non-identifier characters the same way the old engine's labelFor does", () => {
    expect(entityLabelFor(1, "Line-Item")).toBe("RtApp1_Line_Item");
  });
});

describe("labels: prepareAppCypher — rewrites known entity labels, rejects unknown ones", () => {
  const entities = new Set(["Vendor", "PurchaseOrder"]);

  it("rewrites a known entity label to the application-scoped namespace", () => {
    const out = prepareAppCypher("MATCH (v:Vendor) RETURN v.name AS name", 7, entities, new Set());
    expect(out).toBe("MATCH (v:RtApp7_Vendor) RETURN v.name AS name");
  });

  it("rejects a label this application doesn't declare as an entity", () => {
    expect(() => prepareAppCypher("MATCH (x:SomethingElse) RETURN x", 7, entities, new Set()))
      .toThrow(/Unknown entity "SomethingElse"/);
  });

  it("still rejects a relationship pattern — entities are joined via WHERE, never -[...]->", () => {
    expect(() => prepareAppCypher("MATCH (v:Vendor)-[:OWNS]->(p:PurchaseOrder) RETURN v", 7, entities, new Set()))
      .toThrow(/Relationship patterns are not supported/);
  });

  it("never rewrites a label that happens to appear inside a string literal", () => {
    const out = prepareAppCypher('MATCH (v:Vendor) WHERE v.name = "Vendor" RETURN v', 7, entities, new Set());
    expect(out).toBe('MATCH (v:RtApp7_Vendor) WHERE v.name = "Vendor" RETURN v');
  });
});
