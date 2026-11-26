import type { ApiResponse } from "@/lib/types";

/** Largest JSON body the letter APIs accept (text plus uploaded stickers). */
export const MAX_JSON_BYTES = 1_000_000;

export function ok<T>(data: T, status = 200): Response {
  return Response.json({ success: true, data } satisfies ApiResponse<T>, { status });
}

export function fail(error: string, status: number): Response {
  return Response.json({ success: false, error } satisfies ApiResponse<never>, { status });
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Parse a JSON body with a size cap; throws HttpError on bad input. */
export async function readJson(request: Request, maxBytes = MAX_JSON_BYTES): Promise<unknown> {
  const text = await request.text();
  if (new TextEncoder().encode(text).length > maxBytes) {
    throw new HttpError("请求内容过大", 413);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError("请求格式不正确", 400);
  }
}

/** Turn any thrown value into a response; unexpected errors are logged, not leaked. */
export function toErrorResponse(error: unknown, context: string): Response {
  if (error instanceof HttpError) return fail(error.message, error.status);
  console.error(`[${context}]`, error);
  return fail("服务暂时不可用，请稍后再试", 500);
}

export const OUTBOX_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
