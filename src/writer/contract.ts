import { join } from "node:path";
import { DATA_LAYOUT } from "../data-dir.js";

/**
 * What the plugin and the writer process have to agree on.
 *
 * Kept apart from `main.ts` because the plugin needs these values and
 * importing `main.ts` to get them would run the writer inside the Signal K
 * process — the one thing this design exists to prevent. Nothing here imports
 * a storage engine, so it is safe on both sides.
 */

/**
 * The writer's exit codes. The plugin reads them and turns them into something
 * an operator can see.
 *
 * `EXIT_LOCKED` is named separately from a general failure because the remedy
 * differs: another writer owns the store, and retrying cannot help.
 */
export const EXIT_LOCKED = 3;

/** Where the writer's three files live under the resolved data directory. */
export function writerPaths(dataDir: string): {
  store: string;
  lock: string;
  socket: string;
} {
  const hot = join(dataDir, DATA_LAYOUT.hotStore);
  return {
    store: join(hot, "hot.sqlite"),
    lock: join(hot, "writer.lock"),
    socket: join(hot, "writer.sock"),
  };
}
