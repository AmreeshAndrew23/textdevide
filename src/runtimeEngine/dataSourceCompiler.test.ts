import { describe, expect, it } from "vitest";
import { compileDataSource } from "./dataSourceCompiler.js";
import { parseDataSourceElement } from "./applicationModel.js";

const ENTITIES = new Set(["Vendor", "PurchaseOrder"]);

const ACTIVE_VENDORS_XML = `<DataSource name="activeVendors" type="query">
  <Select entity="Vendor">
    <Field name="id"/><Field name="name"/>
    <Condition field="status" operator="equals" value="active"/>
    <Condition field="branch" operator="equals" value="{session.branch}"/>
    <Sort by="name" order="asc"/>
  </Select>
  <ValueField>id</ValueField><DisplayField>name</DisplayField>
</DataSource>`;

const VENDOR_SPEND_XML = `<DataSource name="vendorSpend" type="query">
  <Select entity="PurchaseOrder">
    <Field name="vendor.name" alias="name"/>
    <Field name="totalAmount" aggregate="sum" alias="totalSpend"/>
    <GroupBy field="vendor.name"/><Sort by="totalSpend" order="desc"/>
  </Select>
</DataSource>`;

describe("dataSourceCompiler: activeVendors — the simple, Phase-1-supported case", () => {
  const def = parseDataSourceElement(ACTIVE_VENDORS_XML);

  it("compiles to a parameterized Cypher statement, resolving {session.branch} into a bound param, never interpolated into the text", () => {
    const { statement, params } = compileDataSource(def, 7, ENTITIES, { branch: "NYC" });
    expect(statement).toBe('MATCH (n:RtApp7_Vendor) WHERE n.status = $cond0 AND n.branch = $cond1 RETURN n.id AS id, n.name AS name ORDER BY n.name ASC');
    expect(params).toEqual({ cond0: "active", cond1: "NYC" });
    expect(statement).not.toContain("NYC"); // the resolved session value is bound, not inlined
  });

  it("rejects an unknown entity (defense in depth — this def's entity should already be validated upstream)", () => {
    const badDef = { ...def, entity: "NotARealEntity" };
    expect(() => compileDataSource(badDef, 7, ENTITIES, {})).toThrow(/Unknown entity/);
  });
});

describe("dataSourceCompiler: vendorSpend — Phase 2 features rejected with a clear error, not silently wrong Cypher", () => {
  const def = parseDataSourceElement(VENDOR_SPEND_XML);

  it("throws for an aggregate field", () => {
    expect(() => compileDataSource(def, 7, ENTITIES, {})).toThrow(/aggregate fields aren't supported yet/);
  });
});
