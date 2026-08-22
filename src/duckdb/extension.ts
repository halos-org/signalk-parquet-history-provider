import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import {
  SQLITE_SCANNER,
  bundledExtensionRelPath,
  currentDuckdbPlatform,
  duckdbVersionFromPackageVersion,
} from "./duckdb-version.js";

/**
 * Base DuckDB settings for every instance this package creates.
 *
 * Both flags are security settings, not conveniences: with autoload on, a
 * query naming an unknown function makes DuckDB fetch a binary from the
 * internet and run it, at query time, in a process that holds the vessel's
 * history. Restricting file access and locking the configuration after
 * startup is the other half, and belongs with the query layer that knows
 * which directories are legitimate (halos-org/halos#166).
 */
export const BASE_DUCKDB_CONFIG: Readonly<Record<string, string>> =
  Object.freeze({
    autoinstall_known_extensions: "false",
    autoload_known_extensions: "false",
  });

export interface ExtensionManifest {
  duckdbVersion: string;
  /** sha256 of the compressed file, per platform triple. */
  platforms: Record<string, { sha256: string; bytes: number }>;
}

/** The installed package's root, from this module's own location. */
export function packageRoot(): string {
  // dist/duckdb/extension.js -> dist/duckdb -> dist -> package root
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/** The DuckDB version this package is pinned to, read from the dependency
 * that supplies the engine. `package.json` pins it exactly for this reason:
 * a range would let an install drift the engine away from the bundled
 * extension, which only shows up as a `LOAD` failure on the device. */
export function pinnedDuckdbVersion(root: string = packageRoot()): string {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  const spec = pkg.dependencies?.["@duckdb/node-api"];
  if (!spec) {
    throw new Error("package.json does not depend on @duckdb/node-api");
  }
  return duckdbVersionFromPackageVersion(spec);
}

export function readManifest(root: string = packageRoot()): ExtensionManifest {
  const path = join(root, "extensions", "manifest.json");
  if (!existsSync(path)) {
    throw new Error(
      `No bundled DuckDB extensions found at ${path}. ` +
        `Run \`./run fetch-extensions\` in a clone; an installed copy should ` +
        `have shipped them.`,
    );
  }
  return JSON.parse(readFileSync(path, "utf8")) as ExtensionManifest;
}

export interface ResolveOptions {
  /** Where the decompressed binary is cached. The plugin's data directory —
   * the package directory is not reliably writable. */
  cacheDir: string;
  root?: string;
  platform?: string;
  extension?: string;
}

/**
 * The absolute path of a loadable `sqlite_scanner` for this platform.
 *
 * The package ships the binary gzipped, because that is 8 MB against 27 MB
 * and npm would compress it anyway. DuckDB's `LOAD '<path>'` needs the
 * decompressed file, so the first caller on a device expands it into the
 * cache and every later one finds it there. Version- and platform-keyed, so
 * a DuckDB upgrade expands a fresh copy rather than loading a stale one.
 */
export function resolveExtension(options: ResolveOptions): string {
  const root = options.root ?? packageRoot();
  const platform = options.platform ?? currentDuckdbPlatform();
  const extension = options.extension ?? SQLITE_SCANNER;
  const manifest = readManifest(root);
  const version = manifest.duckdbVersion;

  const target = join(
    options.cacheDir,
    `v${version}`,
    platform,
    `${extension}.duckdb_extension`,
  );
  if (existsSync(target) && statSync(target).size > 0) return target;

  const source = join(
    root,
    bundledExtensionRelPath(version, platform, extension),
  );
  if (!existsSync(source)) {
    const shipped = Object.keys(manifest.platforms).join(", ") || "none";
    throw new Error(
      `This build bundles ${extension} for ${shipped}, not for ${platform}. ` +
        `Add it to the published platform set, or run ` +
        `\`./run fetch-extensions ${platform}\` in a clone.`,
    );
  }

  const compressed = readFileSync(source);
  const expected = manifest.platforms[platform];
  if (expected) {
    const actual = createHash("sha256").update(compressed).digest("hex");
    if (actual !== expected.sha256) {
      throw new Error(
        `Bundled ${extension} for ${platform} does not match the manifest ` +
          `checksum (${actual} vs ${expected.sha256}).`,
      );
    }
  }

  mkdirSync(dirname(target), { recursive: true });
  // Expand through a private temporary name and rename into place: several
  // query processes can spawn at once, and a reader must never see a
  // half-written 27 MB binary. rename() within one directory is atomic.
  const temp = `${target}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, gunzipSync(compressed));
    chmodSync(temp, 0o644);
    renameSync(temp, target);
  } catch (err) {
    try {
      unlinkSync(temp);
    } catch {
      /* the temp file may never have been created */
    }
    throw err;
  }
  return target;
}

/** Minimal shape of what `DuckDBConnection` offers us, so this module stays
 * out of the plugin's import graph — see src/test/plugin-import-graph.test.ts. */
export interface Runnable {
  run(sql: string): Promise<unknown>;
}

/** Load the bundled sqlite_scanner into an open connection. */
export async function loadSqliteScanner(
  connection: Runnable,
  options: ResolveOptions,
): Promise<string> {
  const path = resolveExtension(options);
  // A single-quoted literal: the path is ours (package root plus configured
  // cache directory), and DuckDB has no parameter binding for LOAD.
  await connection.run(`LOAD '${path.replaceAll("'", "''")}'`);
  return path;
}
