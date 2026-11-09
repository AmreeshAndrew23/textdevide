import { describe, expect, it } from "vitest";
import { diffElements } from "./versionStore.js";

const el = (tag: string, name: string, xml = "x") => ({ tag, name, xml });

describe("versionStore.diffElements: what a restore would change", () => {
  it("reports additions, removals and edits by element", () => {
    const current = [el("Entity", "Patient"), el("Screen", "NewScreen"), el("Theme", "default", "new")];
    const target = [el("Entity", "Patient"), el("Entity", "Ward"), el("Theme", "default", "old")];
    expect(diffElements(current, target)).toEqual({
      added: ["Entity: Ward"], removed: ["Screen: NewScreen"], changed: ["Theme: default"],
    });
  });

  it("treats same-named elements of different types as different", () => {
    expect(diffElements([el("Screen", "Patient")], [el("Entity", "Patient")])).toEqual({
      added: ["Entity: Patient"], removed: ["Screen: Patient"], changed: [],
    });
  });

  it("reports nothing for identical definitions", () => {
    expect(diffElements([el("Entity", "A")], [el("Entity", "A")])).toEqual({ added: [], removed: [], changed: [] });
  });
});
