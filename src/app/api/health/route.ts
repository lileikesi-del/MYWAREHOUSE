import { cloudflareBindings } from "@/lib/server/cloudflare";

/**
 * Deployment self-check. Reports what the Worker can actually see at runtime:
 * which bindings exist, whether the letters table is there, and whether R2 is
 * writable. Deliberately dependency-free so it still answers when the rest of
 * the app is broken.
 */
export const dynamic = "force-dynamic";

const PROBE_KEY = "health-probe.txt";

async function checkDatabase(env: { DB?: unknown }): Promise<Record<string, unknown>> {
  if (!env.DB) return { bound: false, error: "no DB binding" };
  const db = env.DB as {
    prepare: (sql: string) => {
      all: <T>() => Promise<{ results: T[] }>;
      first: <T>() => Promise<T | null>;
    };
  };
  try {
    const tables = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>();
    const names = tables.results.map((r) => r.name);
    const hasLetters = names.includes("letters");
    let count: number | null = null;
    let lettersError: string | null = null;
    if (hasLetters) {
      try {
        const row = await db.prepare("SELECT COUNT(*) AS n FROM letters").first<{ n: number }>();
        count = row?.n ?? null;
      } catch (error) {
        lettersError = error instanceof Error ? error.message : String(error);
      }
    }
    return { bound: true, tables: names, hasLetters, count, lettersError };
  } catch (error) {
    return { bound: true, error: error instanceof Error ? error.message : String(error) };
  }
}

async function checkBucket(bucket: unknown, label: string): Promise<Record<string, unknown>> {
  if (!bucket) return { bound: false, error: `${label} binding missing` };
  const r2 = bucket as {
    put: (key: string, value: string) => Promise<unknown>;
    get: (key: string) => Promise<{ text: () => Promise<string> } | null>;
    delete: (key: string) => Promise<void>;
  };
  try {
    await r2.put(PROBE_KEY, "ok");
    const read = await r2.get(PROBE_KEY);
    const text = read ? await read.text() : null;
    await r2.delete(PROBE_KEY);
    return { bound: true, writable: text === "ok" };
  } catch (error) {
    return { bound: true, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function GET(): Promise<Response> {
  const env = (await cloudflareBindings()) as Record<string, unknown> | null;
  if (!env) {
    return Response.json({ runtime: "node (no Cloudflare bindings)", env: null }, { status: 200 });
  }
  const report = {
    runtime: "cloudflare-worker",
    bindings: Object.keys(env).sort(),
    database: await checkDatabase(env as { DB?: unknown }),
    audio: await checkBucket(env.AUDIO, "AUDIO"),
    cache: await checkBucket(env.NEXT_INC_CACHE_R2_BUCKET, "NEXT_INC_CACHE_R2_BUCKET"),
    time: new Date().toISOString(),
  };
  return Response.json(report, { status: 200, headers: { "cache-control": "no-store" } });
}
