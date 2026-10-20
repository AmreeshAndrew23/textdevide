import { describe, expect, it } from "vitest";
import { buildDependencyIndex, affectedValidations, runValidations, resolveViaAlias } from "./validationEngine.js";
import type { ValidationDef, RelationshipDef } from "./applicationModel.js";

const relationships: RelationshipDef[] = [
  { name: "PO-to-Vendor", fromEntity: "PurchaseOrder", fromField: "vendorId", toEntity: "Vendor", toField: "id", cardinality: "N:1", onDelete: "restrict" },
  { name: "LineItem-to-PO", fromEntity: "LineItem", fromField: "poId", toEntity: "PurchaseOrder", toField: "id", cardinality: "N:1", onDelete: "cascade" },
];

const totalMatchesLines: ValidationDef = {
  id: "total-matches-lines", entity: "PurchaseOrder", when: "onSave", onViolation: "reject",
  dependsOn: [{ field: "totalAmount", via: null }, { field: "amount", via: "lineItems" }],
  test: "totalAmount == sum(lineItems.amount)", message: "Total must equal the sum of line items",
};
const orderDateNotFuture: ValidationDef = {
  id: "order-date-not-future", entity: "PurchaseOrder", when: "onChange", onViolation: "reject",
  dependsOn: [{ field: "orderDate", via: null }],
  test: "orderDate <= now()", message: "Order date cannot be in the future",
};
const validations = [totalMatchesLines, orderDateNotFuture];

describe("validationEngine: resolveViaAlias — a plural alias resolves to the related entity via a declared Relationship", () => {
  it("resolves lineItems (on PurchaseOrder) to LineItem via LineItem-to-PO", () => {
    expect(resolveViaAlias("PurchaseOrder", "lineItems", relationships)).toBe("LineItem");
  });
  it("returns null for an alias with no matching Relationship", () => {
    expect(resolveViaAlias("PurchaseOrder", "nonsense", relationships)).toBeNull();
  });
});

describe("validationEngine: buildDependencyIndex + affectedValidations — driven only by dependsOn, never by parsing test", () => {
  const index = buildDependencyIndex(validations, relationships);

  it("a direct-field change on the Validation's own entity affects it", () => {
    expect(affectedValidations("PurchaseOrder", ["orderDate"], index).map((v) => v.id)).toEqual(["order-date-not-future"]);
  });

  it("a via-resolved change on the RELATED entity affects the owning Validation", () => {
    expect(affectedValidations("LineItem", ["amount"], index).map((v) => v.id)).toEqual(["total-matches-lines"]);
  });

  it("changing an unrelated field on an unrelated entity affects nothing", () => {
    expect(affectedValidations("Vendor", ["name"], index)).toEqual([]);
  });

  it("changing totalAmount on PurchaseOrder affects total-matches-lines only, not order-date-not-future", () => {
    expect(affectedValidations("PurchaseOrder", ["totalAmount"], index).map((v) => v.id)).toEqual(["total-matches-lines"]);
  });
});

describe("validationEngine: runValidations — passed=true means the condition holds (record is valid)", () => {
  it("total-matches-lines passes when totals genuinely match", () => {
    const [result] = runValidations([totalMatchesLines], {
      fields: { totalAmount: 35 }, related: { lineItems: [{ amount: 10 }, { amount: 25 }] }, session: {},
    });
    expect(result).toEqual({ id: "total-matches-lines", passed: true, message: "Total must equal the sum of line items", onViolation: "reject" });
  });
  it("total-matches-lines fails (violation) when totals don't match", () => {
    const [result] = runValidations([totalMatchesLines], {
      fields: { totalAmount: 999 }, related: { lineItems: [{ amount: 10 }] }, session: {},
    });
    expect(result.passed).toBe(false);
  });
});
