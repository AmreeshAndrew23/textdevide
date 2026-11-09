import { describe, expect, it } from "vitest";
import { buildAppModel, type StoredElement } from "./publicAccess.js";
import { buildSampleRows, entitiesToFill, saveOrder } from "./sampleData.js";

const f = (name: string, extra = "") => `<Field name="${name}" type="string"${extra}/>`;
const ELEMENTS: StoredElement[] = [
  { tag: "Entity", name: "User", xml: `<Entity name="User" isAccount="true">${f("id", ` key="true"`)}${f("email")}${f("passwordHash")}${f("mustChangePassword")}${f("firstName")}${f("lastName")}${f("dob")}${f("emailVerified")}${f("authProvider")}</Entity>` },
  { tag: "Entity", name: "Appointment", xml: `<Entity name="Appointment">${f("id", ` key="true"`)}${f("reason")}${f("patientId")}${f("doctorId")}<Field name="photo" type="image"/></Entity>` },
  { tag: "Entity", name: "Patient", xml: `<Entity name="Patient">${f("id", ` key="true"`)}${f("fullName")}</Entity>` },
  { tag: "Entity", name: "Doctor", xml: `<Entity name="Doctor">${f("id", ` key="true"`)}${f("fullName")}</Entity>` },
  { tag: "Relationship", name: "ap", xml: `<Relationship name="ap" fromEntity="Appointment" fromField="patientId" toEntity="Patient" toField="id" cardinality="N:1"/>` },
  { tag: "Relationship", name: "ad", xml: `<Relationship name="ad" fromEntity="Appointment" fromField="doctorId" toEntity="Doctor" toField="id" cardinality="N:1"/>` },
];
const model = buildAppModel(ELEMENTS);
const byName = (n: string) => model.entities.find((e) => e.name === n)!;
let counter = 0;
const newKey = () => `key-${++counter}`;

describe("sampleData: example records are safe to save", () => {
  it("saves parents before children, and survives circular links", () => {
    const order = saveOrder([byName("Appointment"), byName("Patient"), byName("Doctor")], model.relationships).map((e) => e.name);
    expect(order.indexOf("Appointment")).toBe(2);
    expect(saveOrder([byName("Patient")], [
      { fromEntity: "Patient", toEntity: "Doctor" }, { fromEntity: "Doctor", toEntity: "Patient" },
    ] as never).map((e) => e.name)).toEqual(["Patient"]);
  });

  it("never fills accounts, the role entity, or anything that already has records", () => {
    const fill = entitiesToFill(model, "Doctor", new Map([["Patient", ["p1"]]])).map((e) => e.name);
    expect(fill).toEqual(["Appointment"]);
  });

  it("replaces placeholder ids and rewrites links, dropping fields the app doesn't have", () => {
    const fill = ["Appointment", "Patient", "Doctor"].map(byName);
    const rows = buildSampleRows(model, {
      Patient: [{ id: "p-a", fullName: "Asha" }],
      Doctor: [{ id: "d-a", fullName: "Dr Rao" }],
      Appointment: [{ id: "x", reason: "Checkup", patientId: "p-a", doctorId: "d-a", photo: "http://evil", hacked: "yes" }],
    }, fill, new Map(), newKey);
    expect(rows.map((r) => r.entity.name).pop()).toBe("Appointment");
    const patient = rows.find((r) => r.entity.name === "Patient")!;
    const appt = rows.find((r) => r.entity.name === "Appointment")!;
    expect(patient.row.id).not.toBe("p-a");
    expect(appt.row.patientId).toBe(patient.key);
    expect(appt.row).not.toHaveProperty("photo");
    expect(appt.row).not.toHaveProperty("hacked");
  });

  it("links to existing records when the parent module already has some, and drops unresolvable links", () => {
    const rows = buildSampleRows(model, {
      Appointment: [{ id: "x", reason: "A", patientId: "ghost", doctorId: "ghost" }],
    }, [byName("Appointment")], new Map([["Patient", ["real-1"]]]), newKey);
    expect(rows[0].row.patientId).toBe("real-1");
    expect(rows[0].row).not.toHaveProperty("doctorId");
  });

  it("ignores malformed AI output and caps volume", () => {
    expect(buildSampleRows(model, { Patient: "nope", Doctor: [null, 3] }, ["Patient", "Doctor"].map(byName), new Map(), newKey)).toEqual([]);
    const many = Array.from({ length: 500 }, (_, i) => ({ id: String(i), fullName: "x" }));
    expect(buildSampleRows(model, { Patient: many }, [byName("Patient")], new Map(), newKey)).toHaveLength(40);
  });
});
