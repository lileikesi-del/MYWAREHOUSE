import type { DeliveryChoice, Letter, LetterStatus, PublicLetter } from "./model";

const MINUTE = 60_000;

/** Local calendar date (YYYY-MM-DD parts) of `now` for a getTimezoneOffset() value. */
function localParts(now: Date, tzOffsetMinutes: number): { y: number; m: number; d: number } {
  const local = new Date(now.getTime() - tzOffsetMinutes * MINUTE);
  return { y: local.getUTCFullYear(), m: local.getUTCMonth() + 1, d: local.getUTCDate() };
}

/** UTC instant of local midnight on y-m-d. */
function localMidnight(y: number, m: number, d: number, tzOffsetMinutes: number): Date {
  return new Date(Date.UTC(y, m - 1, d) + tzOffsetMinutes * MINUTE);
}

function nextAnnual(month: number, day: number, now: Date, tz: number): Date {
  const { y } = localParts(now, tz);
  const thisYear = localMidnight(y, month, day, tz);
  return thisYear.getTime() > now.getTime() ? thisYear : localMidnight(y + 1, month, day, tz);
}

/**
 * When a letter arrives: at 00:00 of the chosen day in the sender's own
 * timezone (spec §4.6). `tzOffsetMinutes` is Date#getTimezoneOffset().
 * A custom date of today delivers at once; a past date is refused.
 */
export function resolveDeliverAt(choice: DeliveryChoice, now: Date, tzOffsetMinutes: number): string {
  switch (choice.kind) {
    case "now":
      return now.toISOString();
    case "christmas-eve":
      return nextAnnual(12, 24, now, tzOffsetMinutes).toISOString();
    case "christmas":
      return nextAnnual(12, 25, now, tzOffsetMinutes).toISOString();
    case "date": {
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(choice.date);
      if (!match) throw new Error("送达日期格式不正确");
      const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
      const today = localParts(now, tzOffsetMinutes);
      const chosen = Date.UTC(y, m - 1, d);
      const todayKey = Date.UTC(today.y, today.m - 1, today.d);
      if (chosen < todayKey) throw new Error("送达日期已经过去了");
      if (chosen === todayKey) return now.toISOString();
      return localMidnight(y, m, d, tzOffsetMinutes).toISOString();
    }
  }
}

export function letterStatus(letter: Letter, now: Date): LetterStatus {
  if (letter.recalledAt) return "recalled";
  if (letter.openedAt) return "opened";
  return new Date(letter.deliverAt).getTime() <= now.getTime() ? "delivered" : "in-transit";
}

/** The recipient's view: content only after arrival, never the outbox secret. */
export function toPublicLetter(letter: Letter, now: Date): PublicLetter {
  const status = letterStatus(letter, now);
  const arrived = status === "delivered" || status === "opened";
  const recalled = status === "recalled";
  return {
    id: letter.id,
    status,
    recipientName: recalled ? "" : letter.recipientName,
    envelopeColor: letter.envelopeColor,
    seal: letter.seal,
    deliverAt: letter.deliverAt,
    content: arrived
      ? {
          templateId: letter.templateId,
          paper: letter.paper,
          elements: letter.elements,
          customStickers: letter.customStickers,
          audioUrl: letter.audioUrl,
          audioName: letter.audioName,
        }
      : null,
  };
}
