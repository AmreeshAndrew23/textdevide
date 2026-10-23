/**
 * Picture storage for a Field type="image" (an Employee photo, a Vendor logo, etc.) — local disk
 * under uploads/<applicationId>/, since there's no cloud storage configured in this environment.
 * Deliberately NOT stored in Neo4j: a property value for an "image" field is just the served URL
 * string returned here, same as any other string field as far as entityStore.ts is concerned.
 */
import { randomUUID } from "crypto";
import { mkdir, writeFile, stat } from "fs/promises";
import { createReadStream } from "fs";
import path from "path";

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5MB — generous for a profile photo/logo, not for arbitrary files

// Extension decides the Content-Type on the way back out (servePath below), so the mime check
// AND the extension must agree — never trust a client-supplied filename/extension directly.
const ALLOWED_MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

const UPLOADS_ROOT = path.resolve(process.cwd(), "uploads");

function appDir(applicationId: number): string {
  return path.join(UPLOADS_ROOT, String(applicationId));
}

export class UploadError extends Error {}

// Saves one already-buffered file and returns the URL path the frontend should use as the
// field's stored value (and later request back via servePath) — e.g. "/api/runtime-applications/
// 40/uploads/3f2d....png". Never trusts the client's own filename for anything but logging.
export async function saveUpload(applicationId: number, mimeType: string, buffer: Buffer): Promise<string> {
  const ext = ALLOWED_MIME_TO_EXT[mimeType];
  if (!ext) throw new UploadError(`Unsupported image type "${mimeType}" — only PNG, JPEG, GIF, and WebP are allowed.`);
  if (buffer.length > MAX_UPLOAD_BYTES) throw new UploadError(`Image is too large — the limit is ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB.`);
  const dir = appDir(applicationId);
  await mkdir(dir, { recursive: true });
  const filename = `${randomUUID()}.${ext}`;
  await writeFile(path.join(dir, filename), buffer);
  return `/api/runtime-applications/${applicationId}/uploads/${filename}`;
}

const EXT_TO_CONTENT_TYPE: Record<string, string> = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

// Resolves a requested filename to a real on-disk path, or null if it doesn't exist / isn't a
// plain filename — `filename` comes straight from the URL, so this rejects anything containing a
// path separator before ever touching the filesystem (no traversal outside the app's own folder).
export async function resolveUploadPath(applicationId: number, filename: string): Promise<{ filePath: string; contentType: string } | null> {
  if (!/^[0-9a-f-]+\.(png|jpg|gif|webp)$/i.test(filename)) return null;
  const ext = filename.split(".").pop()!.toLowerCase();
  const filePath = path.join(appDir(applicationId), filename);
  try {
    const s = await stat(filePath);
    if (!s.isFile()) return null;
  } catch {
    return null;
  }
  return { filePath, contentType: EXT_TO_CONTENT_TYPE[ext] };
}

export { createReadStream };
