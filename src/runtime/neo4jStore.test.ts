import { describe, expect, it } from "vitest";
import { injectProjectId, PROJECT_ID_PARAM } from "./neo4jStore.js";
import { prepareCypher } from "./cypher.js";

describe("injectProjectId: stamps a projectId property onto every CREATE/MERGE node pattern", () => {
  it("adds projectId to a pattern that already has a property map", () => {
    const { statement, params } = injectProjectId(7, "CREATE (s:Student {regNo: $r})", { r: "A1" });
    expect(statement).toBe(`CREATE (s:Student {regNo: $r, projectId: $${PROJECT_ID_PARAM}})`);
    expect(params).toEqual({ r: "A1", [PROJECT_ID_PARAM]: 7 });
  });

  it("adds a property map when the pattern has none", () => {
    const { statement, params } = injectProjectId(7, "CREATE (s:Student)", {});
    expect(statement).toBe(`CREATE (s:Student {projectId: $${PROJECT_ID_PARAM}})`);
    expect(params).toEqual({ [PROJECT_ID_PARAM]: 7 });
  });

  it("handles an explicitly empty property map", () => {
    const { statement } = injectProjectId(7, "CREATE (s:Student {})", {});
    expect(statement).toBe(`CREATE (s:Student {projectId: $${PROJECT_ID_PARAM}})`);
  });

  it("injects into every pattern of a comma-separated CREATE, not just the first", () => {
    const { statement } = injectProjectId(
      7, "CREATE (s:Student {regNo: $r}), (c:Course {code: $c}), (d:Dept)", { r: "A1", c: "CS1" }
    );
    expect(statement).toBe(
      `CREATE (s:Student {regNo: $r, projectId: $${PROJECT_ID_PARAM}}), ` +
      `(c:Course {code: $c, projectId: $${PROJECT_ID_PARAM}}), ` +
      `(d:Dept {projectId: $${PROJECT_ID_PARAM}})`
    );
  });

  it("injects into MERGE the same way as CREATE", () => {
    const { statement } = injectProjectId(7, "MERGE (s:Student {regNo: $r})", { r: "A1" });
    expect(statement).toBe(`MERGE (s:Student {regNo: $r, projectId: $${PROJECT_ID_PARAM}})`);
  });

  it("injects into each clause of two separate CREATE statements joined by WITH", () => {
    const { statement } = injectProjectId(
      7, "CREATE (s:Student {regNo: $r}) WITH s CREATE (e:Enroll {sid: s.regNo})", { r: "A1" }
    );
    expect(statement).toBe(
      `CREATE (s:Student {regNo: $r, projectId: $${PROJECT_ID_PARAM}}) WITH s ` +
      `CREATE (e:Enroll {sid: s.regNo, projectId: $${PROJECT_ID_PARAM}})`
    );
  });

  it("does not get confused by braces/parens/commas inside a string literal property value", () => {
    const { statement } = injectProjectId(
      7, 'CREATE (s:Student {bio: "Likes (lists), {braces}"})', {}
    );
    expect(statement).toBe(
      `CREATE (s:Student {bio: "Likes (lists), {braces}", projectId: $${PROJECT_ID_PARAM}})`
    );
  });

  it("leaves a read-only MATCH statement completely unaffected", () => {
    const { statement, params } = injectProjectId(7, "MATCH (s:Student) RETURN s", { x: 1 });
    expect(statement).toBe("MATCH (s:Student) RETURN s");
    expect(params).toEqual({ x: 1 });
  });

  it("the injected statement still passes prepareCypher with the param declared", () => {
    const tables = new Set(["Student"]);
    const { statement, params } = injectProjectId(7, "CREATE (s:Student {regNo: $r})", { r: "A1" });
    const cypher = prepareCypher(statement, 7, tables, new Set(Object.keys(params)));
    expect(cypher).toBe(`CREATE (s:Proj7_Student {regNo: $r, projectId: $${PROJECT_ID_PARAM}})`);
  });
});
