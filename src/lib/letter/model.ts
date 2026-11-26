import type { CardTemplateId } from "@/lib/types";

/** The two inside surfaces a sender can decorate (spec §4.3). */
export type Face = "inside-left" | "inside-right";
export type Ink = "black" | "red" | "gold";
export type FontId = "hand-en" | "hand-zh" | "serif";

/** The fixed places text goes on the inside-right page (mobile editor spec §6). */
export const TEXT_SLOTS = ["greeting", "body", "signature"] as const;
export type TextSlot = (typeof TEXT_SLOTS)[number];

export const PAPER_STOCK_IDS = ["cold-press", "kraft", "pearl"] as const;
export type PaperStock = (typeof PAPER_STOCK_IDS)[number];

export const ENVELOPE_COLORS = ["ivory", "kraft", "sage", "midnight"] as const;
export type EnvelopeColor = (typeof ENVELOPE_COLORS)[number];

export const SEAL_COLORS = ["red", "green", "gold", "navy"] as const;
export type SealColor = (typeof SEAL_COLORS)[number];

export const STAMP_IDS = ["snowflake", "star", "holly", "reindeer", "gift", "initials"] as const;
export type StampId = (typeof STAMP_IDS)[number];

/** Sticker ids from the winter set (spec appendix A). */
export const STICKER_IDS = [
  "star-gold",
  "sparkles",
  "bell",
  "moon",
  "snowflake",
  "cloud",
  "holly",
  "pine-tree",
  "gift",
  "bow",
  "gingerbread",
  "stocking",
] as const;
export type StickerId = (typeof STICKER_IDS)[number];

export const STICKER_MATERIALS = ["paint", "foil", "pearl"] as const;
export type StickerMaterial = (typeof STICKER_MATERIALS)[number];

/**
 * A sender-uploaded sticker. The image travels inside the letter as a data
 * URL so the recipient sees it without a separate asset server.
 */
export interface CustomSticker {
  id: string;
  label: string;
  material: StickerMaterial;
  src: string;
}

export const LIMITS = {
  /** One page holds a generous pile, since repeat taps stack copies. */
  stickersPerFace: 30,
  textsPerFace: 5,
  textLength: 200,
  /** Greeting and signature are one short line each. */
  slotLineLength: 40,
  recipientLength: 40,
  minScale: 0.2,
  maxScale: 3,
  /** Uploaded stickers kept with one letter (each is embedded as a data URL). */
  customStickers: 8,
} as const;

/** Where an element sits on its face; x/y are 0..1 of the face's size. */
export interface Placement {
  face: Face;
  x: number;
  y: number;
  scale: number;
  rotation: number; // radians
  z: number;
}

export type CardElement =
  | ({ kind: "sticker"; stickerId: string } & Placement)
  | ({ kind: "text"; text: string; font: FontId; ink: Ink; slot?: TextSlot } & Placement);

export interface Seal {
  color: SealColor;
  stamp: StampId;
  initials?: string;
}

/** Everything the sender authors; what the editor keeps as a draft. */
export interface LetterDraft {
  templateId: CardTemplateId;
  paper: PaperStock;
  envelopeColor: EnvelopeColor;
  seal: Seal;
  recipientName: string;
  elements: CardElement[];
  /** Sender-uploaded sticker images, referenced by `stickerId` in elements. */
  customStickers?: CustomSticker[];
  audioUrl: string | null;
  audioName: string | null;
}

/** A sent letter as stored. `outboxId` is the sender's secret. */
export interface Letter extends LetterDraft {
  id: string;
  outboxId: string;
  deliverAt: string;
  createdAt: string;
  openedAt: string | null;
  recalledAt: string | null;
}

export type LetterStatus = "in-transit" | "delivered" | "opened" | "recalled";

export type DeliveryChoice =
  | { kind: "now" }
  | { kind: "christmas-eve" }
  | { kind: "christmas" }
  | { kind: "date"; date: string }; // YYYY-MM-DD, sender's local calendar

/** What a recipient may see; `content` only once the letter has arrived. */
export interface PublicLetter {
  id: string;
  status: LetterStatus;
  recipientName: string;
  envelopeColor: EnvelopeColor;
  seal: Seal;
  deliverAt: string;
  content: {
    templateId: CardTemplateId;
    paper: PaperStock;
    elements: CardElement[];
    customStickers?: CustomSticker[];
    audioUrl: string | null;
    audioName: string | null;
  } | null;
}

/** One row of the sender's outbox. */
export interface OutboxEntry {
  id: string;
  recipientName: string;
  createdAt: string;
  deliverAt: string;
  openedAt: string | null;
  status: LetterStatus;
}
