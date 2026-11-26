import { z } from "zod";
import {
  ENVELOPE_COLORS,
  LIMITS,
  PAPER_STOCK_IDS,
  SEAL_COLORS,
  STAMP_IDS,
  STICKER_IDS,
  STICKER_MATERIALS,
  TEXT_SLOTS,
  type CardElement,
} from "./model";

// Legacy ids stay valid so stored letters keep parsing; new letters pick
// from CARD_TEMPLATES (the active four).
const TEMPLATE_IDS = [
  "first-snow",
  "home-christmas",
  "sweet-dreams",
  "lantern-light",
  "winter-moonlight",
  "forest-letter",
  "gift-atelier",
  "snow-town",
] as const;
const FACES = ["inside-left", "inside-right"] as const;
/** Covers the right page's margin around the sheet (about 0.1 of it each side). */
const PAGE_MARGIN = 0.2;

const placement = {
  face: z.enum(FACES),
  // The right page runs past its letter sheet to the panel's edges (PAGE_BOX), so
  // a centre there can sit a little outside the sheet's 0..1.
  x: z.number().min(-PAGE_MARGIN).max(1 + PAGE_MARGIN),
  y: z.number().min(-PAGE_MARGIN).max(1 + PAGE_MARGIN),
  scale: z.number().min(LIMITS.minScale).max(LIMITS.maxScale),
  rotation: z.number().min(-Math.PI * 2).max(Math.PI * 2),
  z: z.number().int().min(0).max(1000),
};

const stickerElement = z.object({
  kind: z.literal("sticker"),
  // Built-in ids are checked together with the letter's custom stickers below.
  stickerId: z.string().trim().min(1).max(80),
  ...placement,
});

/** An uploaded sticker, embedded in the letter so the recipient sees it too. */
const customStickerSchema = z.object({
  id: z.string().regex(/^custom-[A-Za-z0-9_-]{6,64}$/, "自定义贴纸 ID 不合法"),
  label: z.string().trim().min(1).max(60),
  material: z.enum(STICKER_MATERIALS),
  src: z.string().startsWith("data:image/").max(100_000, "贴纸图片太大"),
});

const textElement = z.object({
  kind: z.literal("text"),
  text: z.string().trim().min(1, "文字不能为空").max(LIMITS.textLength, `每段文字最多 ${LIMITS.textLength} 字`),
  font: z.enum(["hand-en", "hand-zh", "serif"]),
  ink: z.enum(["black", "red", "gold"]),
  slot: z.enum(TEXT_SLOTS).optional(),
  ...placement,
}).refine(
  (t) => t.slot === undefined || t.slot === "body" || t.text.length <= LIMITS.slotLineLength,
  `称呼和落款最多 ${LIMITS.slotLineLength} 字`,
);

const elementSchema = z.discriminatedUnion("kind", [stickerElement, textElement]);

function countOn(elements: CardElement[], kind: CardElement["kind"], face: string): number {
  return elements.filter((e) => e.kind === kind && e.face === face).length;
}

const sealSchema = z
  .object({
    color: z.enum(SEAL_COLORS),
    stamp: z.enum(STAMP_IDS),
    initials: z.string().trim().min(1).max(2).optional(),
  })
  .refine((s) => s.stamp !== "initials" || Boolean(s.initials), "首字母印章需要填写首字母");

const audioUrl = z
  .string()
  .trim()
  .refine((v) => v.startsWith("/api/audio/") || v.startsWith("/uploads/"), "无效的音频路径");

const draftShape = {
  templateId: z.enum(TEMPLATE_IDS),
  paper: z.enum(PAPER_STOCK_IDS),
  envelopeColor: z.enum(ENVELOPE_COLORS),
  seal: sealSchema,
  recipientName: z.string().trim().min(1, "请填写收件人").max(LIMITS.recipientLength),
  elements: z.array(elementSchema).max((LIMITS.stickersPerFace + LIMITS.textsPerFace) * FACES.length),
  customStickers: z.array(customStickerSchema).max(LIMITS.customStickers, `最多上传 ${LIMITS.customStickers} 张贴纸`).optional(),
  audioUrl: audioUrl.nullable(),
  audioName: z.string().trim().max(160).nullable(),
};

function checkLimits(d: { elements: CardElement[]; customStickers?: { id: string }[] }, ctx: z.RefinementCtx): void {
  const custom = d.customStickers ?? [];
  const seenCustom = new Set<string>();
  for (const sticker of custom) {
    if (seenCustom.has(sticker.id)) {
      ctx.addIssue({ code: "custom", message: "自定义贴纸重复", path: ["customStickers"] });
      break;
    }
    seenCustom.add(sticker.id);
  }
  // Every placed sticker must resolve either to the built-in winter set or to
  // one of this letter's uploaded stickers.
  const known = new Set<string>(STICKER_IDS);
  for (const sticker of custom) known.add(sticker.id);
  for (const element of d.elements) {
    if (element.kind === "sticker" && !known.has(element.stickerId)) {
      ctx.addIssue({ code: "custom", message: "贴纸不存在", path: ["elements"] });
      break;
    }
  }
  for (const slot of TEXT_SLOTS) {
    if (d.elements.filter((e) => e.kind === "text" && e.slot === slot).length > 1) {
      ctx.addIssue({ code: "custom", message: "每个文字区只能有一段文字", path: ["elements"] });
    }
  }
  for (const face of FACES) {
    if (countOn(d.elements, "sticker", face) > LIMITS.stickersPerFace) {
      ctx.addIssue({ code: "custom", message: `每一面最多 ${LIMITS.stickersPerFace} 张贴纸`, path: ["elements"] });
    }
    if (countOn(d.elements, "text", face) > LIMITS.textsPerFace) {
      ctx.addIssue({ code: "custom", message: `每一面最多 ${LIMITS.textsPerFace} 段文字`, path: ["elements"] });
    }
  }
}

/** A letter ready to send. */
export const letterDraftSchema = z.object(draftShape).superRefine(checkLimits);

/** A draft still being made: same rules, but the recipient may be blank. */
export const storedDraftSchema = z
  .object({ ...draftShape, recipientName: z.string().max(LIMITS.recipientLength) })
  .superRefine(checkLimits);

/** Body of POST /api/letters: the draft plus its resolved delivery time. */
export const sendLetterSchema = letterDraftSchema.and(
  z.object({
    deliverAt: z.iso.datetime({ message: "无效的送达时间" }),
    outboxId: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/).nullable().optional(),
  }),
);

export type SendLetterBody = z.infer<typeof sendLetterSchema>;
