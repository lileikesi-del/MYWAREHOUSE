import { nanoid } from "nanoid";
import type { Letter, LetterDraft } from "./model";

/**
 * The slice of Cloudflare's D1 API the repository uses. Production passes
 * the real D1 binding; local dev and tests pass `openSqliteD1()`.
 */
export interface D1StatementLike {
  bind(...values: unknown[]): D1StatementLike;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number } }>;
}

export interface D1Like {
  prepare(sql: string): D1StatementLike;
  exec(sql: string): Promise<unknown>;
}

export const LETTERS_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS letters (
  id TEXT PRIMARY KEY,
  outbox_id TEXT NOT NULL,
  deliver_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  opened_at TEXT,
  recalled_at TEXT,
  draft TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS letters_outbox ON letters (outbox_id, created_at);`;

export type OpenResult =
  | { ok: true; letter: Letter }
  | { ok: false; reason: "not-found" | "not-delivered" | "recalled" };

export type RecallResult =
  | { ok: true; letter: Letter }
  | { ok: false; reason: "not-found" | "forbidden" | "already-delivered" | "opened" };

export interface LetterRepository {
  create(input: LetterDraft & { deliverAt: string }, outboxId: string | null, now: Date): Promise<Letter>;
  findById(id: string): Promise<Letter | null>;
  listByOutbox(outboxId: string): Promise<Letter[]>;
  markOpened(id: string, now: Date): Promise<OpenResult>;
  recall(id: string, outboxId: string, now: Date): Promise<RecallResult>;
}

interface Row {
  id: string;
  outbox_id: string;
  deliver_at: string;
  created_at: string;
  opened_at: string | null;
  recalled_at: string | null;
  draft: string;
}

const LETTER_ID_LENGTH = 12;
const OUTBOX_ID_LENGTH = 24;

function toLetter(row: Row): Letter {
  const draft = JSON.parse(row.draft) as LetterDraft;
  return {
    ...draft,
    id: row.id,
    outboxId: row.outbox_id,
    deliverAt: row.deliver_at,
    createdAt: row.created_at,
    openedAt: row.opened_at,
    recalledAt: row.recalled_at,
  };
}

function draftOf(input: LetterDraft): LetterDraft {
  return {
    templateId: input.templateId,
    paper: input.paper,
    envelopeColor: input.envelopeColor,
    seal: input.seal,
    recipientName: input.recipientName,
    elements: input.elements,
    customStickers: input.customStickers ?? [],
    audioUrl: input.audioUrl,
    audioName: input.audioName,
  };
}

export function createLetterRepository(db: D1Like): LetterRepository {
  const findById = async (id: string): Promise<Letter | null> => {
    const row = await db.prepare("SELECT * FROM letters WHERE id = ?").bind(id).first<Row>();
    return row ? toLetter(row) : null;
  };

  return {
    async create(input, outboxId, now) {
      const id = nanoid(LETTER_ID_LENGTH);
      const outbox = outboxId ?? nanoid(OUTBOX_ID_LENGTH);
      // A delivery time already behind us means "now" (clock skew, a slow send).
      const deliverAt = new Date(Math.max(new Date(input.deliverAt).getTime(), now.getTime())).toISOString();
      await db
        .prepare(
          "INSERT INTO letters (id, outbox_id, deliver_at, created_at, opened_at, recalled_at, draft) VALUES (?, ?, ?, ?, NULL, NULL, ?)",
        )
        .bind(id, outbox, deliverAt, now.toISOString(), JSON.stringify(draftOf(input)))
        .run();
      const letter = await findById(id);
      if (!letter) throw new Error("letter vanished right after insert");
      return letter;
    },

    findById,

    async listByOutbox(outboxId) {
      const { results } = await db
        .prepare("SELECT * FROM letters WHERE outbox_id = ? ORDER BY created_at DESC")
        .bind(outboxId)
        .all<Row>();
      return results.map(toLetter);
    },

    async markOpened(id, now) {
      const letter = await findById(id);
      if (!letter) return { ok: false, reason: "not-found" };
      if (letter.recalledAt) return { ok: false, reason: "recalled" };
      if (new Date(letter.deliverAt).getTime() > now.getTime()) return { ok: false, reason: "not-delivered" };
      // Conditional update keeps the first opening even under concurrent calls.
      await db
        .prepare("UPDATE letters SET opened_at = ? WHERE id = ? AND opened_at IS NULL AND recalled_at IS NULL")
        .bind(now.toISOString(), id)
        .run();
      const updated = await findById(id);
      return updated ? { ok: true, letter: updated } : { ok: false, reason: "not-found" };
    },

    async recall(id, outboxId, now) {
      const letter = await findById(id);
      if (!letter) return { ok: false, reason: "not-found" };
      if (letter.outboxId !== outboxId) return { ok: false, reason: "forbidden" };
      if (letter.openedAt) return { ok: false, reason: "opened" };
      if (new Date(letter.deliverAt).getTime() <= now.getTime()) return { ok: false, reason: "already-delivered" };
      await db
        .prepare("UPDATE letters SET recalled_at = ? WHERE id = ? AND recalled_at IS NULL")
        .bind(now.toISOString(), id)
        .run();
      const updated = await findById(id);
      return updated ? { ok: true, letter: updated } : { ok: false, reason: "not-found" };
    },
  };
}
