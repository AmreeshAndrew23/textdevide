import { describe, expect, it, afterAll } from "vitest";
import { rm } from "fs/promises";
import path from "path";
import { saveUpload, resolveUploadPath, UploadError } from "./uploads.js";

// Real filesystem I/O (this module's whole job), scoped to a throwaway applicationId so it never
// collides with anything real, cleaned up afterward.
const TEST_APP_ID = 999999;
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // not a complete PNG, just distinct bytes — saveUpload only checks mimetype, not file contents

afterAll(async () => {
  await rm(path.resolve(process.cwd(), "uploads", String(TEST_APP_ID)), { recursive: true, force: true });
});

describe("uploads.saveUpload: only known image mime types are ever accepted", () => {
  it("saves a PNG and returns a URL scoped to the application", async () => {
    const url = await saveUpload(TEST_APP_ID, "image/png", PNG_BYTES);
    expect(url).toMatch(new RegExp(`^/api/runtime-applications/${TEST_APP_ID}/uploads/[0-9a-f-]+\\.png$`));
  });

  it("rejects an unsupported mime type (e.g. an executable or a PDF) before writing anything", async () => {
    await expect(saveUpload(TEST_APP_ID, "application/octet-stream", PNG_BYTES)).rejects.toThrow(UploadError);
    await expect(saveUpload(TEST_APP_ID, "application/pdf", PNG_BYTES)).rejects.toThrow(UploadError);
  });

  it("rejects a file over the size limit", async () => {
    const huge = Buffer.alloc(6 * 1024 * 1024); // 6MB > the 5MB limit
    await expect(saveUpload(TEST_APP_ID, "image/png", huge)).rejects.toThrow(/too large/);
  });
});

describe("uploads.resolveUploadPath: never serves anything outside the expected filename shape", () => {
  it("resolves a real, just-uploaded file", async () => {
    const url = await saveUpload(TEST_APP_ID, "image/jpeg", PNG_BYTES);
    const filename = url.split("/").pop()!;
    const resolved = await resolveUploadPath(TEST_APP_ID, filename);
    expect(resolved).toMatchObject({ contentType: "image/jpeg" });
  });

  it("returns null for a filename that doesn't exist", async () => {
    expect(await resolveUploadPath(TEST_APP_ID, "00000000-0000-0000-0000-000000000000.png")).toBeNull();
  });

  // Path traversal — the whole reason this isn't just "join(dir, filename)" with no validation.
  it("returns null for a path-traversal attempt rather than ever touching the filesystem outside the app's own folder", async () => {
    expect(await resolveUploadPath(TEST_APP_ID, "../../../../etc/passwd")).toBeNull();
    expect(await resolveUploadPath(TEST_APP_ID, "..%2f..%2fsecret.png")).toBeNull();
  });

  it("returns null for a disallowed extension even if a file with that exact name existed", async () => {
    expect(await resolveUploadPath(TEST_APP_ID, "whatever.exe")).toBeNull();
    expect(await resolveUploadPath(TEST_APP_ID, "whatever.svg")).toBeNull(); // SVG can carry script — deliberately not in the allowed set
  });
});
