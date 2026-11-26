import { z } from "zod";
import { STICKER_IDS, STICKER_MATERIALS, type StickerMaterial } from "@/lib/letter/model";

const entrySchema = z.object({
  id: z.enum(STICKER_IDS),
  label: z.string().min(1),
  material: z.enum(STICKER_MATERIALS),
  src: z.string().startsWith("/assets/stickers/"),
});

const manifestSchema = z.object({
  set: z.string().min(1),
  stickers: z.array(entrySchema),
});

/**
 * A sticker the 3D layer can bake. Built-in entries come from the manifest;
 * uploaded entries live on the letter itself and use a data URL for `src`.
 */
export interface StickerEntry {
  id: string;
  label: string;
  material: StickerMaterial;
  src: string;
}

export interface StickerManifest {
  set: string;
  stickers: StickerEntry[];
}

/** Validate manifest.json from scripts/stickers/cutout.py; throws on a bad file. */
export function parseStickerManifest(json: unknown): StickerManifest {
  const parsed = manifestSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`贴纸清单无效: ${parsed.error.issues[0]?.message ?? "unknown"}`);
  }
  return parsed.data;
}
