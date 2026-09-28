import { describe, expect, it } from "vitest";
import { ARTIFACT_KINDS, nodesToScreens, overlayWorkspace, screensToNodes, splitPatch } from "./projectStore.js";
import { prepareCypher } from "../runtime/cypher.js";
import type { ProjectRow } from "../db/schema.js";

describe("projectStore: which database each field goes to", () => {
  it("routes generated work to Neo4j and project details to Postgres", () => {
    const { pg, artifacts, screens } = splitPatch({
      name: "App", description: "d", features: "f", status: "draft", uiTheme: "rose",
      entities: "{}", erDiagram: "erd", validationRules: "r", validationCode: "c",
      uiDescription: "u", uiCode: "code", uiXml: "x", uiHtml: "h", uiApi: "a",
      uiScreens: "[]",
    });
    expect(Object.keys(pg).sort()).toEqual(["description", "features", "name", "status", "uiTheme"]);
    expect(Object.keys(artifacts).sort()).toEqual(Object.keys(ARTIFACT_KINDS).sort());
    expect(screens).toBe("[]");
  });
  it("leaves fields it was not given untouched (undefined, not null)", () => {
    const { pg, artifacts, screens } = splitPatch({ status: "finalized" });
    expect(pg).toEqual({ status: "finalized" });
    expect(artifacts).toEqual({});
    expect(screens).toBeUndefined();
  });
  it("keeps an explicit null so a field can be cleared", () => {
    expect(splitPatch({ erDiagram: null, uiScreens: null }).artifacts.erDiagram).toBeNull();
    expect(splitPatch({ uiScreens: null }).screens).toBeNull();
  });
});

describe("projectStore: screens <-> Neo4j nodes", () => {
  const screens = [
    { id: "b", name: "Second", xml: "<screen/>", primary_entities: ["X"], extra: { keep: true } },
    { id: "a", name: "First", xml: "", description: "d" },
  ];
  it("round-trips the array in order, keeping every field", () => {
    const nodes = screensToNodes(JSON.stringify(screens));
    expect(nodes.map((n) => [n.screenId, n.position])).toEqual([["b", 0], ["a", 1]]);
    const shuffled = [nodes[1], nodes[0]]; // Neo4j returns rows in any order
    expect(JSON.parse(nodesToScreens(shuffled)!)).toEqual(screens);
  });
  it("an empty or missing list stores no nodes and reads back as null", () => {
    expect(screensToNodes("[]")).toEqual([]);
    expect(screensToNodes(null)).toEqual([]);
    expect(nodesToScreens([])).toBeNull();
  });
  it("rejects bad input before anything is written", () => {
    expect(() => screensToNodes("not json")).toThrow(/JSON array/);
    expect(() => screensToNodes('{"a":1}')).toThrow(/JSON array/);
    expect(() => screensToNodes('[{"name":"no id"}]')).toThrow(/string id/);
  });
});

describe("projectStore: overlaying Neo4j data on the Postgres row", () => {
  const row = { id: 1, name: "P", entities: "LEGACY", uiScreens: "LEGACY", uiXml: "LEGACY", status: "draft" } as unknown as ProjectRow;
  it("replaces every moved field, and nulls the ones Neo4j has nothing for", () => {
    const out = overlayWorkspace(row, { artifacts: new Map([["entities", '{"tables":[]}']]), screens: '[{"id":"s"}]' });
    expect(out.entities).toBe('{"tables":[]}');
    expect(out.uiScreens).toBe('[{"id":"s"}]');
    expect(out.uiXml).toBeNull();
    expect(out.name).toBe("P");
    expect(out.status).toBe("draft");
  });
});

describe("workspace labels are unreachable from user/AI queries", () => {
  it("prepareCypher rejects Td* labels (only a project's own tables are allowed)", () => {
    const tables = new Set(["Student"]);
    for (const label of ["TdArtifact", "TdScreen", "TdWorkspace"]) {
      expect(() => prepareCypher(`MATCH (n:${label}) RETURN n.content AS c`, 7, tables, new Set())).toThrow();
    }
  });
});
