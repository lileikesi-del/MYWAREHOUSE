import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LETTERS_SCHEMA_SQL } from "@/lib/letter/repository";
import { createFsUploadStore, createR2UploadStore, isUploadKey, type R2Like, MAX_UPLOAD_BYTES, validateUpload } from "./uploadStore";

describe("validateUpload", () => {
  it("accepts an mp3 and gives it a random key keeping the extension", () => {
    const r = validateUpload({ name: "我的歌.mp3", type: "audio/mpeg", size: 3_000_000 });
    expect(r.ok && r.key).toMatch(/^[A-Za-z0-9_-]{16}\.mp3$/);
  });

  it("rejects a non-audio file", () => {
    expect(validateUpload({ name: "x.png", type: "image/png", size: 100 }).ok).toBe(false);
  });

  it("rejects an empty file", () => {
    expect(validateUpload({ name: "x.mp3", type: "audio/mpeg", size: 0 }).ok).toBe(false);
  });

  it("rejects a file over the size limit", () => {
    expect(validateUpload({ name: "x.mp3", type: "audio/mpeg", size: MAX_UPLOAD_BYTES + 1 }).ok).toBe(false);
  });

  it("falls back to the extension when the browser sends no type", () => {
    const r = validateUpload({ name: "voice.m4a", type: "", size: 10 });
    expect(r.ok && r.contentType).toBe("audio/mp4");
  });

  it("types an m4a by its extension whatever the browser calls it", () => {
    for (const type of ["audio/x-m4a", "audio/m4a", "audio/mp4a-latm"]) {
      const r = validateUpload({ name: "converted.m4a", type, size: 10 });
      expect(r.ok && r.contentType).toBe("audio/mp4");
    }
  });
});

describe("validateUpload with the sniffed format", () => {
  it("stores a renamed mp3 as an mp3", () => {
    const r = validateUpload({ name: "renamed.m4a", type: "audio/x-m4a", size: 10 }, "mp3");
    expect(r.ok && r.key).toMatch(/\.mp3$/);
    expect(r.ok && r.contentType).toBe("audio/mpeg");
  });

  it("keeps the extension when the content could not be recognised", () => {
    const r = validateUpload({ name: "song.m4a", type: "", size: 10 }, null);
    expect(r.ok && r.key).toMatch(/\.m4a$/);
  });

  it("still rejects a non-audio extension even if the bytes look like audio", () => {
    expect(validateUpload({ name: "x.png", type: "image/png", size: 10 }, "mp3").ok).toBe(false);
  });
});

describe("isUploadKey", () => {
  it("refuses path tricks", () => {
    expect(isUploadKey("../../etc/passwd")).toBe(false);
    expect(isUploadKey("abcdefghijklmnop.mp3")).toBe(true);
  });
});

describe("filesystem upload store", () => {
  it("stores and returns a file with its type", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "uploads-"));
    const store = createFsUploadStore(dir);
    await store.put("abcdefghijklmnop.mp3", new TextEncoder().encode("hi").buffer as ArrayBuffer, "audio/mpeg");
    const got = await store.get("abcdefghijklmnop.mp3");
    expect(got?.contentType).toBe("audio/mpeg");
    expect(new TextDecoder().decode(got?.body)).toBe("hi");
    expect(await store.get("missingmissingmi.mp3")).toBeNull();
  });

  it("returns just a span of a file, and its full size", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "uploads-"));
    const store = createFsUploadStore(dir);
    await store.put("abcdefghijklmnop.mp3", new TextEncoder().encode("0123456789").buffer as ArrayBuffer, "audio/mpeg");
    expect(await store.head("abcdefghijklmnop.mp3")).toEqual({ size: 10 });
    expect(await store.head("missingmissingmi.mp3")).toBeNull();
    const got = await store.get("abcdefghijklmnop.mp3", { offset: 3, length: 4 });
    expect(new TextDecoder().decode(got?.body)).toBe("3456");
    expect(got?.size).toBe(10);
  });
});

describe("R2 upload store", () => {
  it("asks R2 for only the requested span", async () => {
    const calls: unknown[] = [];
    const bucket: R2Like = {
      async put() {
        return null;
      },
      async head() {
        return { size: 10 };
      },
      async get(_key, options) {
        calls.push(options);
        return { size: 10, httpMetadata: { contentType: "audio/mp4" }, arrayBuffer: async () => new ArrayBuffer(4) };
      },
    };
    const store = createR2UploadStore(bucket);
    const got = await store.get("abcdefghijklmnop.m4a", { offset: 3, length: 4 });
    expect(calls).toEqual([{ range: { offset: 3, length: 4 } }]);
    expect(got?.size).toBe(10);
    expect(await store.head("abcdefghijklmnop.m4a")).toEqual({ size: 10 });
  });
});

describe("D1 migration", () => {
  it("matches the schema the repository creates", () => {
    // Checked-out on Windows the file has CRLF endings; compare the SQL only.
    const sql = readFileSync(path.join(process.cwd(), "migrations/0001_letters.sql"), "utf8").replace(/\r\n/g, "\n").trim();
    expect(sql).toBe(LETTERS_SCHEMA_SQL.trim());
  });
});
