import { describe, expect, it } from "vitest";
import { parseApplicationXml } from "./applicationModel.js";
import { lintApplication } from "./appLint.js";

const lint = (body: string) => lintApplication(parseApplicationXml(`<Application name="X">${body}</Application>`).elements);
const errors = (body: string) => lint(body).filter((i) => i.severity === "error").map((i) => i.message);

const AUDIT = `<Auditing name="standard" concurrency="timestamp"><Field role="createdBy" name="createdBy"/><Field role="createdOn" name="createdOn"/><Field role="updatedBy" name="updatedBy"/><Field role="updatedOn" name="updatedOn"/></Auditing>`;
const VENDOR = `<Entity name="Vendor" auditing="standard"><Field name="id" type="string" key="true"/><Field name="name" type="string"/></Entity>`;
const PO = `<Entity name="PO"><Field name="id" type="string" key="true"/><Field name="vendorId" type="string"/><Field name="status" type="enum"><Value>open</Value></Field></Entity>`;
const LINK = `<Relationship name="r" fromEntity="PO" fromField="vendorId" toEntity="Vendor" toField="id" cardinality="N:1"/>`;
const DS = `<DataSource name="vendors" type="query"><Select entity="Vendor"><Field name="id"/><Field name="name"/><Sort by="name" order="asc"/></Select><ValueField>id</ValueField><DisplayField>name</DisplayField></DataSource>`;
const FORM = `<Screen name="POForm" entity="PO" type="form"><Fields><UIField label="Vendor" control="dropdown" valueFrom="field:vendorId" optionsFrom="query:vendors"/><UIField label="Status" bind="status"/></Fields><Buttons><Button label="Save" event="click" action="save"/></Buttons></Screen>`;
const LIST = `<Screen name="POList" entity="PO"><Grid name="g" entity="PO" readonly="true"><Column header="Status" bind="status"/><Events><On event="rowClick" action="openRecord" targetScreen="POForm"/></Events></Grid></Screen>`;
const VENDOR_SCREENS = `<Screen name="VForm" entity="Vendor" type="form"><Fields><UIField label="Name" bind="name"/></Fields><Buttons><Button label="Save" event="click" action="save"/></Buttons></Screen><Screen name="VList" entity="Vendor"><Grid name="g" entity="Vendor"><Column header="Name" bind="name"/><Column header="By" bind="createdBy"/><Events><On event="rowClick" action="openRecord" targetScreen="VForm"/></Events></Grid></Screen>`;
const GOOD = AUDIT + VENDOR + PO + LINK + DS + FORM + LIST + VENDOR_SCREENS;

describe("appLint: finds what would break, and only that", () => {
  it("passes a correct application with no issues, including audit columns", () => {
    expect(lint(GOOD)).toEqual([]);
  });

  it("does not flag sign-in screens for binding submitted-only values", () => {
    const f = (n: string) => `<Field name="${n}" type="string"/>`;
    const user = `<Entity name="User" isAccount="true"><Field name="id" type="string" key="true"/>${["email", "passwordHash"].map(f).join("")}<Field name="mustChangePassword" type="boolean"/>${["firstName", "lastName"].map(f).join("")}<Field name="dob" type="date"/><Field name="emailVerified" type="boolean"/>${f("authProvider")}</Entity>`;
    const auth = (n: string, a: string, b: string) => `<Screen name="${n}" entity="User" type="form"><Fields><UIField label="x" bind="${b}"/></Fields><Buttons><Button label="Go" event="click" action="${a}"/></Buttons></Screen>`;
    const screens = auth("Login", "login", "password") + auth("Signup", "register", "password") + auth("VerifyEmail", "verifyEmail", "otpCode") + auth("ForgotPassword", "requestPasswordReset", "email") + auth("ResetPassword", "resetPassword", "newPassword") + auth("ChangePassword", "changePassword", "currentPassword");
    expect(errors(user + screens)).toEqual([]);
    expect(errors(user + auth("Login", "login", "password"))).toEqual(expect.arrayContaining([expect.stringMatching(/no "Signup" screen/)]));
  });

  it.each([
    ["a link to a missing entity", GOOD.replace('toEntity="Vendor"', 'toEntity="Supplier"'), /Supplier/],
    ["a link on a missing field", GOOD.replace('fromField="vendorId"', 'fromField="supplierId"'), /PO\.supplierId/],
    ["a form bound to a missing field", GOOD.replace('bind="status"/></Fields>', 'bind="state"/></Fields>'), /PO\.state/],
    ["a column on a missing field", GOOD.replace('header="Status" bind="status"', 'header="Status" bind="stage"'), /PO\.stage/],
    ["a dropdown with no source", GOOD.replace("query:vendors", "query:suppliers"), /suppliers/],
    ["a row click to a missing screen", GOOD.replace('targetScreen="POForm"', 'targetScreen="Nope"'), /"Nope"/],
    ["a button with no action", GOOD.replace('action="save"', 'action="approve"'), /"approve"/],
    ["a source on a missing field", GOOD.replace("<DisplayField>name", "<DisplayField>title"), /Vendor\.title/],
    ["an enum with no choices", GOOD.replace("<Value>open</Value>", ""), /no <Value>/],
    ["no key field", GOOD.replace('name="id" type="string" key="true"/><Field name="vendorId"', 'name="id" type="string"/><Field name="vendorId"'), /exactly one key/],
    ["a missing auditing definition", GOOD.replace(AUDIT, ""), /Auditing "standard"/],
  ])("reports %s", (_name, xml, pattern) => {
    expect(errors(xml).join("\n")).toMatch(pattern);
  });

  it("reports role-gated screens that nobody could ever open", () => {
    expect(errors(GOOD.replace('name="POForm" entity="PO"', 'name="POForm" requiresRole="Admin" entity="PO"')).join()).toMatch(/nobody could ever open/);
  });

  it("warns, without failing, about records that can't be reached", () => {
    const issues = lint(AUDIT + VENDOR + VENDOR_SCREENS + `<Entity name="Ghost"><Field name="id" type="string" key="true"/></Entity>`);
    expect(issues).toEqual([{ severity: "warning", message: expect.stringMatching(/Ghost has no screen/) }]);
  });
});
