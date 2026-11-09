import { describe, expect, it } from "vitest";
import {
  buildAppModel, canEnterScreen, canReadEntity, canUseDataSource, elementsForViewer, isActionAllowed, isValidSlug,
  sanitizeRow, slugify, topRole, type StoredElement,
} from "./publicAccess.js";

const screen = (name: string, entity: string, attrs = "", body = "<Fields/><Buttons><Button label=\"Save\" event=\"click\" action=\"save\"/></Buttons>") => ({
  tag: "Screen", name, xml: `<Screen name="${name}" entity="${entity}" type="form"${attrs}>${body}</Screen>`,
});
const grid = (name: string, entity: string, attrs = "") => ({
  tag: "Screen", name,
  xml: `<Screen name="${name}" entity="${entity}" type="grid"${attrs}><Grid name="g" entity="${entity}"><Columns><Column header="Id" bind="id"/></Columns></Grid></Screen>`,
});

const ELEMENTS: StoredElement[] = [
  { tag: "Theme", name: "t", xml: `<Theme name="t"/>` },
  { tag: "Entity", name: "User", xml: `<Entity name="User" isAccount="true"><Field name="id" type="string" key="true"/><Field name="email" type="string"/><Field name="passwordHash" type="string"/><Field name="mustChangePassword" type="boolean"/><Field name="firstName" type="string"/><Field name="lastName" type="string"/><Field name="dob" type="date"/><Field name="emailVerified" type="boolean"/><Field name="authProvider" type="string"/><Field name="roleId" type="string"/></Entity>` },
  { tag: "Entity", name: "AccessRole", xml: `<Entity name="AccessRole"><Field name="id" type="string" key="true"/><Field name="name" type="string"/></Entity>` },
  { tag: "Entity", name: "Patient", xml: `<Entity name="Patient"><Field name="id" type="string" key="true"/></Entity>` },
  { tag: "Entity", name: "Payroll", xml: `<Entity name="Payroll"><Field name="id" type="string" key="true"/></Entity>` },
  { tag: "Relationship", name: "userRole", xml: `<Relationship name="userRole" fromEntity="User" fromField="roleId" toEntity="AccessRole" toField="id" cardinality="N:1"/>` },
  { tag: "Validation", name: "v1", xml: `<Validation id="v1" entity="Patient" when="onSave" onViolation="reject"><Condition test="true"/><Message>x</Message></Validation>` },
  { tag: "DataSource", name: "AllPayroll", xml: `<DataSource name="AllPayroll"><Select entity="Payroll"><Field name="id"/></Select></DataSource>` },
  { tag: "DataSource", name: "Leaky", xml: `<DataSource name="Leaky" displayField="passwordHash"><Select entity="User"><Field name="passwordHash"/></Select></DataSource>` },
  screen("Login", "User"), screen("Signup", "User"), screen("ChangePassword", "User"),
  grid("PatientList", "Patient"), screen("PatientForm", "Patient"),
  grid("PayrollList", "Payroll", ` requiresRole="Admin"`),
  grid("UserList", "User"), grid("UserAdmin", "User", ` requiresRole="Admin"`),
];
const model = buildAppModel(ELEMENTS);
const named = (n: string) => model.screens.find((s) => s.name === n)!;
const anon = { signedIn: false, role: null };
const member = { signedIn: true, role: null };
const admin = { signedIn: true, role: "Admin" };

describe("publicAccess: a public app denies by default", () => {
  it("shows only sign-in screens to anonymous visitors", () => {
    expect(canEnterScreen(model, named("Login"), anon)).toBe(true);
    expect(canEnterScreen(model, named("PatientList"), anon)).toBe(false);
    expect(canEnterScreen(model, named("ChangePassword"), anon)).toBe(false);
  });

  it("enforces requiresRole for reads, not just actions", () => {
    expect(canEnterScreen(model, named("PayrollList"), member)).toBe(false);
    expect(canReadEntity(model, "Payroll", member)).toBe(false);
    expect(canReadEntity(model, "Payroll", admin)).toBe(true);
    expect(canReadEntity(model, "Patient", member)).toBe(true);
    expect(canReadEntity(model, "Patient", anon)).toBe(false);
  });

  it("never exposes the account entity through an unrestricted screen or a sign-in screen", () => {
    expect(canEnterScreen(model, named("UserList"), member)).toBe(false);
    expect(canReadEntity(model, "User", member)).toBe(false);
    expect(canEnterScreen(model, named("UserList"), admin)).toBe(false); // no requiresRole at all
    expect(canReadEntity(model, "User", admin)).toBe(true); // via UserAdmin
  });

  it("only allows actions that belong to the screen they run on", () => {
    expect(isActionAllowed(named("Login"), "login")).toBe(true);
    expect(isActionAllowed(named("Login"), "register")).toBe(false);
    expect(isActionAllowed(named("Login"), "save")).toBe(false);
    expect(isActionAllowed(named("PatientForm"), "save")).toBe(true);
    expect(isActionAllowed(named("PatientForm"), "someHiddenAction")).toBe(false);
    expect(isActionAllowed(named("PatientForm"), "login")).toBe(false);
    expect(isActionAllowed(named("PatientForm"), "delete")).toBe(false);
    expect(isActionAllowed(named("PatientList"), "delete")).toBe(true);
  });

  it("gates dropdown sources and refuses any that select secrets", () => {
    const source = (n: string) => model.dataSources.find((d) => d.name === n)!;
    expect(canUseDataSource(model, source("AllPayroll"), member)).toBe(false);
    expect(canUseDataSource(model, source("Leaky"), admin)).toBe(false);
  });

  it("sends each viewer only the definition they need", () => {
    const tags = (v: typeof anon) => elementsForViewer(ELEMENTS, model, v);
    expect(tags(anon).map((e) => e.name).sort()).toEqual(["ChangePassword", "Login", "Signup", "User", "t"].filter((n) => n !== "ChangePassword").sort());
    const seen = tags(member).map((e) => e.name);
    expect(seen).toEqual(expect.arrayContaining(["PatientList", "PatientForm", "Patient", "ChangePassword"]));
    expect(seen).not.toEqual(expect.arrayContaining(["PayrollList"]));
    expect(seen).not.toContain("Payroll");
    expect(tags(admin).some((e) => e.tag === "Validation")).toBe(false);
  });

  it("strips secrets from every row", () => {
    expect(sanitizeRow({ id: "1", email: "a@b.c", passwordHash: "x", __otpCode: "123456", __otpExpiresAt: "t", __otpPurpose: "p", __version: 2 }))
      .toEqual({ id: "1", email: "a@b.c", __version: 2 });
  });

  it("picks the first account's role and makes valid link names", () => {
    expect(topRole(model.screens)).toBe("Admin");
    expect(slugify("Hospital Patient Management!")).toBe("hospital-patient-management");
    expect(slugify("!!!")).toBe("app");
    expect(isValidSlug("city-hospital")).toBe(true);
    expect(isValidSlug("../etc")).toBe(false);
    expect(isValidSlug("-bad")).toBe(false);
  });
});
