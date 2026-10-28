import { describe, expect, it } from "vitest";
import {
  parseApplicationXml, parseEntityElement, parseRelationshipElement, parseValidationElement,
  parseDataSourceElement, parseScreenElement, parseActionElement, parseAuditingElement,
} from "./applicationModel.js";

// The real Procurement sample from the design spec, verbatim — every assertion below checks this
// exact document parses the way the spec describes it.
const PROCUREMENT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Application name="Procurement" theme="corporate" database="relational">
  <Theme name="corporate">
    <Logo src="company-logo.png" placement="top-left"/>
    <Colors primary="#1B3A6B" accent="#F5A623" background="#FFFFFF"/>
    <Font family="Inter" size="14"/>
    <Style cornerRadius="8" density="comfortable"/>
  </Theme>
  <Session>
    <Variable name="branch" from="user.branch"/>
    <Variable name="region" from="user.region"/>
  </Session>
  <Auditing name="standard" concurrency="timestamp">
    <Field role="createdBy" name="createdBy"/>
    <Field role="createdOn" name="createdOn"/>
    <Field role="updatedBy" name="updatedBy"/>
    <Field role="updatedOn" name="updatedOn"/>
  </Auditing>
  <AutoNumber id="po-numbering" start="1" increment="1" padLength="6" reset="yearly">
    <Prefix>PO-{YYYY}-</Prefix>
  </AutoNumber>
  <Entity name="Vendor" auditing="standard">
    <Field name="id" type="string" key="true" maxLength="36"/>
    <Field name="name" type="string" required="true" maxLength="200"/>
    <Field name="status" type="enum" required="true">
      <Value>active</Value>
      <Value>inactive</Value>
    </Field>
    <Field name="branch" type="string" required="true"/>
  </Entity>
  <Entity name="PurchaseOrder" auditing="standard">
    <Field name="id" type="string" key="true" maxLength="36"/>
    <Field name="poNumber" type="string" required="true" unique="true" autoNumber="po-numbering"/>
    <Field name="vendorId" type="string" required="true"/>
    <Field name="orderDate" type="date" required="true"/>
    <Field name="status" type="enum" required="true">
      <Value>draft</Value><Value>pending-approval</Value><Value>approved</Value><Value>rejected</Value>
    </Field>
    <Field name="totalAmount" type="decimal" precision="18" scale="2" required="true"/>
    <Field name="branchId" type="string"/>
    <Field name="discount" type="decimal"/>
  </Entity>
  <Entity name="LineItem" auditing="standard">
    <Field name="id" type="string" key="true" maxLength="36"/>
    <Field name="poId" type="string" required="true"/>
    <Field name="description" type="string" required="true" maxLength="500"/>
    <Field name="quantity" type="integer" min="1" required="true"/>
    <Field name="unitPrice" type="decimal" precision="18" scale="2" min="0.01" required="true"/>
    <Field name="amount" type="decimal" precision="18" scale="2" required="true"/>
  </Entity>
  <Relationship name="PO-to-Vendor" fromEntity="PurchaseOrder" fromField="vendorId" toEntity="Vendor" toField="id" cardinality="N:1" onDelete="restrict"/>
  <Relationship name="LineItem-to-PO" fromEntity="LineItem" fromField="poId" toEntity="PurchaseOrder" toField="id" cardinality="N:1" onDelete="cascade"/>
  <Validation id="total-matches-lines" entity="PurchaseOrder" when="onSave" onViolation="reject">
    <DependsOn><Field name="totalAmount"/><Field name="amount" via="lineItems"/></DependsOn>
    <Condition test="totalAmount == sum(lineItems.amount)"/>
    <Message>Total must equal the sum of line items</Message>
  </Validation>
  <Validation id="order-date-not-future" entity="PurchaseOrder" when="onChange" onViolation="reject">
    <DependsOn><Field name="orderDate"/></DependsOn>
    <Condition test="orderDate &lt;= now()"/>
    <Message>Order date cannot be in the future</Message>
  </Validation>
  <DataSource name="activeVendors" type="query">
    <Select entity="Vendor">
      <Field name="id"/><Field name="name"/>
      <Condition field="status" operator="equals" value="active"/>
      <Condition field="branch" operator="equals" value="{session.branch}"/>
      <Sort by="name" order="asc"/>
    </Select>
    <ValueField>id</ValueField><DisplayField>name</DisplayField>
  </DataSource>
  <DataSource name="vendorSpend" type="query">
    <Select entity="PurchaseOrder">
      <Field name="vendor.name" alias="name"/>
      <Field name="totalAmount" aggregate="sum" alias="totalSpend"/>
      <GroupBy field="vendor.name"/><Sort by="totalSpend" order="desc"/>
    </Select>
  </DataSource>
  <Screen name="PurchaseOrderForm" entity="PurchaseOrder" type="form">
    <Fields>
      <UIField label="PO Number" bind="poNumber" readonly="true"/>
      <UIField label="Vendor" control="dropdown" valueFrom="field:vendorId" optionsFrom="query:activeVendors"/>
      <UIField label="Order Date" bind="orderDate"/>
      <UIField label="Status" bind="status" control="dropdown"/>
      <UIField label="Total" bind="totalAmount"><On event="change" action="recalculateTotal"/></UIField>
    </Fields>
    <Buttons>
      <Button label="Save" event="click" action="save"/>
      <Button label="Submit" event="click" action="submitForApproval"/>
    </Buttons>
    <Events><On event="load" action="initPO"/></Events>
  </Screen>
  <Screen name="PurchaseOrderBrowse" entity="PurchaseOrder">
    <Grid name="orders" entity="PurchaseOrder" readonly="true">
      <Column header="PO Number" bind="poNumber"/><Column header="Vendor" bind="vendor.name"/>
      <Column header="Date" bind="orderDate"/><Column header="Total" bind="totalAmount"/><Column header="Status" bind="status"/>
      <Events><On event="rowClick" action="openRecord" targetScreen="PurchaseOrderForm"/></Events>
    </Grid>
  </Screen>
  <Screen name="VendorSpendReport">
    <Grid name="spend" rowsFrom="query:vendorSpend" readonly="true">
      <Column header="Vendor" bind="name"/><Column header="Total Spend" bind="totalSpend"/>
    </Grid>
  </Screen>
  <Action name="initPO" entity="PurchaseOrder">
    <Steps><Set field="branchId" value="{session.branch}"/><Set field="status" value="draft"/></Steps>
  </Action>
  <Action name="recalculateTotal" entity="PurchaseOrder">
    <Steps><Set field="totalAmount" value="sum(lineItems.amount)"/></Steps>
  </Action>
  <Action name="submitForApproval" entity="PurchaseOrder">
    <Steps><Set field="status" value="pending-approval"/><Save/><Notify to="manager" message="PO {poNumber} awaiting approval"/></Steps>
  </Action>
</Application>`;

describe("applicationModel: parseApplicationXml splits the root into top-level elements only", () => {
  const manifest = parseApplicationXml(PROCUREMENT_XML);

  it("reads the Application root's own attributes", () => {
    expect(manifest.name).toBe("Procurement");
    expect(manifest.theme).toBe("corporate");
    expect(manifest.database).toBe("relational");
  });

  it("produces exactly 19 top-level elements, in document order, never touching nested tags", () => {
    expect(manifest.elements).toHaveLength(19);
    expect(manifest.elements.map((e) => e.tag)).toEqual([
      "Theme", "Session", "Auditing", "AutoNumber",
      "Entity", "Entity", "Entity",
      "Relationship", "Relationship",
      "Validation", "Validation",
      "DataSource", "DataSource",
      "Screen", "Screen", "Screen",
      "Action", "Action", "Action",
    ]);
    expect(manifest.elements.map((e) => e.name)).toEqual([
      "corporate", "default", "standard", "po-numbering",
      "Vendor", "PurchaseOrder", "LineItem",
      "PO-to-Vendor", "LineItem-to-PO",
      "total-matches-lines", "order-date-not-future",
      "activeVendors", "vendorSpend",
      "PurchaseOrderForm", "PurchaseOrderBrowse", "VendorSpendReport",
      "initPO", "recalculateTotal", "submitForApproval",
    ]);
  });

  it("each element's xml is just that one element, re-parseable on its own", () => {
    const vendor = manifest.elements.find((e) => e.name === "Vendor")!;
    expect(vendor.xml.startsWith("<Entity")).toBe(true);
    expect(vendor.xml).not.toContain("PurchaseOrder"); // doesn't leak sibling content
    expect(parseEntityElement(vendor.xml).name).toBe("Vendor");
  });
});

describe("applicationModel: per-tag typed parsers against the real sample elements", () => {
  const manifest = parseApplicationXml(PROCUREMENT_XML);
  const xmlOf = (tag: string, name: string) => manifest.elements.find((e) => e.tag === tag && e.name === name)!.xml;

  it("parseEntityElement — PurchaseOrder's fields, including the enum's Values and the autoNumber link", () => {
    const po = parseEntityElement(xmlOf("Entity", "PurchaseOrder"));
    expect(po.auditing).toBe("standard");
    expect(po.isAccount).toBe(false); // the sample has no real end-user accounts
    expect(po.fields.map((f) => f.name)).toEqual(["id", "poNumber", "vendorId", "orderDate", "status", "totalAmount", "branchId", "discount"]);
    const poNumber = po.fields.find((f) => f.name === "poNumber")!;
    expect(poNumber.unique).toBe(true);
    expect(poNumber.autoNumber).toBe("po-numbering");
    const status = po.fields.find((f) => f.name === "status")!;
    expect(status.values).toEqual(["draft", "pending-approval", "approved", "rejected"]);
    const totalAmount = po.fields.find((f) => f.name === "totalAmount")!;
    expect(totalAmount.precision).toBe(18);
    expect(totalAmount.scale).toBe(2);
  });

  it("parseEntityElement — isAccount=\"true\" marks the real end-user accounts entity", () => {
    const user = parseEntityElement(
      `<Entity name="User" isAccount="true"><Field name="id" type="string" key="true"/><Field name="username" type="string" required="true" unique="true"/></Entity>`
    );
    expect(user.isAccount).toBe(true);
  });

  // Regression test for a real incident: the AI wrote a User entity with the exact
  // id/username/passwordHash/mustChangePassword shape but forgot isAccount="true" itself, which
  // would have silently broken login/signup for that application.
  it("parseEntityElement — recognizes a User entity by its exact field shape even if isAccount is missing", () => {
    const user = parseEntityElement(
      `<Entity name="User"><Field name="id" type="string" key="true"/><Field name="username" type="string" required="true" unique="true"/><Field name="passwordHash" type="string" required="true"/><Field name="mustChangePassword" type="boolean" required="true"/></Entity>`
    );
    expect(user.isAccount).toBe(true);
  });

  it("parseEntityElement — does NOT treat an unrelated entity named User as an account entity", () => {
    const user = parseEntityElement(
      `<Entity name="User"><Field name="id" type="string" key="true"/><Field name="displayName" type="string"/></Entity>`
    );
    expect(user.isAccount).toBe(false);
  });

  it("parseEntityElement — does NOT treat a differently-named entity with the account shape as an account entity", () => {
    const account = parseEntityElement(
      `<Entity name="Account"><Field name="id" type="string" key="true"/><Field name="username" type="string" required="true" unique="true"/><Field name="passwordHash" type="string" required="true"/><Field name="mustChangePassword" type="boolean" required="true"/></Entity>`
    );
    expect(account.isAccount).toBe(false); // the fixed convention is specifically the name "User"
  });

  // The RBAC convention's one allowed extra field (roleId) must still be recognized by this
  // structural fallback, not just by assertAccountEntityShape — otherwise a User entity that has
  // roleId but forgot isAccount="true" would silently stop being recognized as the account entity
  // at all, a real regression distinct from (and easy to miss alongside) that other check.
  it("parseEntityElement — recognizes a User entity with the optional roleId field even if isAccount is missing", () => {
    const user = parseEntityElement(
      `<Entity name="User"><Field name="id" type="string" key="true"/><Field name="username" type="string" required="true" unique="true"/><Field name="passwordHash" type="string" required="true"/><Field name="mustChangePassword" type="boolean" required="true"/><Field name="roleId" type="string"/></Entity>`
    );
    expect(user.isAccount).toBe(true);
  });

  // CURRENT (email-based) shape — what every app generates from now on. The LEGACY
  // (username-based) tests above exercise the other half of the dual-shape fallback.
  it("parseEntityElement — recognizes a User entity with the current (email-based) shape even if isAccount is missing", () => {
    const user = parseEntityElement(
      `<Entity name="User">
        <Field name="id" type="string" key="true"/>
        <Field name="email" type="string" required="true" unique="true"/>
        <Field name="passwordHash" type="string"/>
        <Field name="mustChangePassword" type="boolean" required="true"/>
        <Field name="firstName" type="string"/>
        <Field name="lastName" type="string"/>
        <Field name="dob" type="date"/>
        <Field name="emailVerified" type="boolean" required="true"/>
        <Field name="authProvider" type="string" required="true"/>
      </Entity>`
    );
    expect(user.isAccount).toBe(true);
  });

  it("parseEntityElement — does NOT recognize a User entity mixing legacy and current fields", () => {
    const user = parseEntityElement(
      `<Entity name="User"><Field name="id" type="string" key="true"/><Field name="username" type="string" required="true" unique="true"/><Field name="email" type="string" required="true" unique="true"/><Field name="passwordHash" type="string"/><Field name="mustChangePassword" type="boolean" required="true"/></Entity>`
    );
    expect(user.isAccount).toBe(false);
  });

  it("parseEntityElement — does NOT recognize a User entity with any OTHER extra field as an account entity", () => {
    const user = parseEntityElement(
      `<Entity name="User"><Field name="id" type="string" key="true"/><Field name="username" type="string" required="true" unique="true"/><Field name="passwordHash" type="string" required="true"/><Field name="mustChangePassword" type="boolean" required="true"/><Field name="employeeCode" type="string"/></Entity>`
    );
    expect(user.isAccount).toBe(false);
  });

  it("parseRelationshipElement — fromField/toField/cardinality/onDelete all read correctly", () => {
    const rel = parseRelationshipElement(xmlOf("Relationship", "LineItem-to-PO"));
    expect(rel).toEqual({ name: "LineItem-to-PO", fromEntity: "LineItem", fromField: "poId", toEntity: "PurchaseOrder", toField: "id", cardinality: "N:1", onDelete: "cascade" });
  });

  it("parseValidationElement — dependsOn (including a via entry) never requires parsing test", () => {
    const v = parseValidationElement(xmlOf("Validation", "total-matches-lines"));
    expect(v.dependsOn).toEqual([{ field: "totalAmount", via: null }, { field: "amount", via: "lineItems" }]);
    expect(v.test).toBe("totalAmount == sum(lineItems.amount)");
    expect(v.message).toBe("Total must equal the sum of line items");
    expect(v.onViolation).toBe("reject");
  });

  it("parseDataSourceElement — activeVendors' conditions, sort, and value/display fields", () => {
    const ds = parseDataSourceElement(xmlOf("DataSource", "activeVendors"));
    expect(ds.entity).toBe("Vendor");
    expect(ds.conditions).toEqual([
      { field: "status", operator: "equals", value: "active" },
      { field: "branch", operator: "equals", value: "{session.branch}" },
    ]);
    expect(ds.sort).toEqual([{ by: "name", order: "asc" }]);
    expect(ds.valueField).toBe("id");
    expect(ds.displayField).toBe("name");
  });

  it("parseDataSourceElement — vendorSpend's aggregate field and groupBy", () => {
    const ds = parseDataSourceElement(xmlOf("DataSource", "vendorSpend"));
    const totalSpend = ds.fields.find((f) => f.alias === "totalSpend")!;
    expect(totalSpend.aggregate).toBe("sum");
    expect(ds.groupBy).toEqual(["vendor.name"]);
  });

  it("parseScreenElement — PurchaseOrderForm: bind shorthand resolves to valueFrom, optionsFrom kept separate, load event captured", () => {
    const screen = parseScreenElement(xmlOf("Screen", "PurchaseOrderForm"));
    expect(screen.type).toBe("form");
    const poNumberField = screen.fields.find((f) => f.label === "PO Number")!;
    expect(poNumberField.valueFrom).toBe("field:poNumber");
    expect(poNumberField.readonly).toBe(true);
    const vendorField = screen.fields.find((f) => f.label === "Vendor")!;
    expect(vendorField.valueFrom).toBe("field:vendorId"); // explicit valueFrom, not derived from bind
    expect(vendorField.optionsFrom).toBe("query:activeVendors");
    const totalField = screen.fields.find((f) => f.label === "Total")!;
    expect(totalField.onEvents).toEqual([{ event: "change", action: "recalculateTotal" }]);
    expect(screen.buttons).toEqual([{ label: "Save", event: "click", action: "save" }, { label: "Submit", event: "click", action: "submitForApproval" }]);
    expect(screen.events).toEqual([{ event: "load", action: "initPO" }]);
  });

  it("parseScreenElement — PurchaseOrderBrowse's entity-bound Grid with a rowClick->targetScreen", () => {
    const screen = parseScreenElement(xmlOf("Screen", "PurchaseOrderBrowse"));
    expect(screen.grid?.entity).toBe("PurchaseOrder");
    expect(screen.grid?.columns).toHaveLength(5);
    expect(screen.grid?.onEvents).toEqual([{ event: "rowClick", action: "openRecord", targetScreen: "PurchaseOrderForm" }]);
  });

  it("parseScreenElement — PurchaseOrderForm has no requiresRole (the common, unrestricted case)", () => {
    const screen = parseScreenElement(xmlOf("Screen", "PurchaseOrderForm"));
    expect(screen.requiresRole).toBeNull();
  });

  it("parseScreenElement — requiresRole splits and trims a comma-separated role list", () => {
    const screen = parseScreenElement(`<Screen name="Payroll" entity="Payroll" type="form" requiresRole="HR, Admin"><Fields/></Screen>`);
    expect(screen.requiresRole).toEqual(["HR", "Admin"]);
  });

  it("parseScreenElement — a blank requiresRole attribute is treated as no restriction", () => {
    const screen = parseScreenElement(`<Screen name="Payroll" entity="Payroll" type="form" requiresRole=""><Fields/></Screen>`);
    expect(screen.requiresRole).toBeNull();
  });

  it("parseScreenElement — VendorSpendReport's query-bound Grid (no entity)", () => {
    const screen = parseScreenElement(xmlOf("Screen", "VendorSpendReport"));
    expect(screen.entity).toBeNull();
    expect(screen.grid?.rowsFrom).toBe("query:vendorSpend");
  });

  it("parseActionElement — submitForApproval's Set/Save/Notify steps in order", () => {
    const action = parseActionElement(xmlOf("Action", "submitForApproval"));
    expect(action.steps).toEqual([
      { kind: "set", field: "status", value: "pending-approval" },
      { kind: "save" },
      { kind: "notify", to: "manager", message: "PO {poNumber} awaiting approval" },
    ]);
  });

  it("parseAuditingElement — role -> column name mapping and concurrency mode", () => {
    const auditing = parseAuditingElement(xmlOf("Auditing", "standard"));
    expect(auditing.concurrency).toBe("timestamp");
    expect(auditing.fields).toEqual([
      { role: "createdBy", name: "createdBy" },
      { role: "createdOn", name: "createdOn" },
      { role: "updatedBy", name: "updatedBy" },
      { role: "updatedOn", name: "updatedOn" },
    ]);
  });
});
