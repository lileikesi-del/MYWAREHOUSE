import type { D1Like } from "@/lib/letter/repository";
import type { R2Like } from "./uploadStore";

/** Bindings declared in wrangler.jsonc. */
export interface CloudflareBindings {
  DB?: D1Like;
  AUDIO?: R2Like;
}

/**
 * True only inside workerd. `getCloudflareContext` does not throw on a plain
 * Node host — it hands back emulated bindings built from wrangler.jsonc, which
 * then blow up on the first query. Workers report this user agent.
 */
function runningOnWorkers(): boolean {
  return typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers";
}

/**
 * The Worker's bindings when running on Cloudflare (or `wrangler`-backed
 * preview); null under plain `next dev` / `next start`, where local stores
 * (SQLite file + data/uploads) are used instead.
 */
export async function cloudflareBindings(): Promise<CloudflareBindings | null> {
  if (!runningOnWorkers()) return null;
  try {
    const { getCloudflareContext } = await import("@opennextjs/cloudflare");
    const { env } = await getCloudflareContext({ async: true });
    return env as unknown as CloudflareBindings;
  } catch {
    return null;
  }
}
