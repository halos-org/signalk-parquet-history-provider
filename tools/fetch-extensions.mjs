#!/usr/bin/env node
/**
 * Download the DuckDB extension binaries this package bundles.
 *
 * They are not committed: each is ~8 MB compressed and would land in the
 * history again on every DuckDB bump. They ARE published, because a device
 * may have no network and DuckDB cannot read the SQLite hot store without
 * sqlite_scanner. `prepublishOnly` runs this, so the npm tarball always
 * carries them.
 *
 *   node tools/fetch-extensions.mjs                  # the published set
 *   node tools/fetch-extensions.mjs --current        # this machine's platform
 *   node tools/fetch-extensions.mjs linux_arm64 ...  # named triples
 *
 * Requires `npm run build` first: the version and path rules live in
 * src/duckdb/duckdb-version.ts so that the build gate, the runtime resolver
 * and this script cannot disagree about which binary is the right one.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const dist = join(ROOT, "dist", "duckdb", "duckdb-version.js");
if (!existsSync(dist)) {
  console.error(
    "dist/ is missing. Run `npm run build` first — this script reads the " +
      "version and path rules from the compiled sources.",
  );
  process.exit(1);
}
const {
  PUBLISHED_PLATFORMS,
  SQLITE_SCANNER,
  bundledExtensionRelPath,
  currentDuckdbPlatform,
  duckdbVersionFromPackageVersion,
  extensionUrl,
} = await import(dist);

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const pinned = pkg.dependencies?.["@duckdb/node-api"];
if (!pinned) {
  console.error("package.json does not depend on @duckdb/node-api");
  process.exit(1);
}
const version = duckdbVersionFromPackageVersion(pinned);

// The claim that stripping `-r.N` yields the DuckDB version is cheap to
// verify here and expensive to be wrong about later: a mismatched extension
// only fails at LOAD, on the device. duckdb-version.ts says this check exists.
const { DuckDBInstance } = await import("@duckdb/node-api");
const { BASE_DUCKDB_CONFIG } = await import(
  join(ROOT, "dist", "duckdb", "extension.js")
);
const instance = await DuckDBInstance.create(":memory:", {
  ...BASE_DUCKDB_CONFIG,
});
const connection = await instance.connect();
const reported = String(
  (await connection.runAndReadAll("select version()")).getRows()[0][0],
).replace(/^v/, "");
if (reported !== version) {
  console.error(
    `@duckdb/node-api@${pinned} reports DuckDB ${reported}, but the version ` +
      `parsed from its npm version is ${version}. The extension repository is ` +
      `keyed by the DuckDB version, so fetching would bundle the wrong binary.`,
  );
  process.exit(1);
}

const args = process.argv.slice(2);
const platforms = args.includes("--current")
  ? [currentDuckdbPlatform()]
  : args.length > 0
    ? args
    : [...PUBLISHED_PLATFORMS];

const extensionsDir = join(ROOT, "extensions");
const versionDir = join(extensionsDir, `v${version}`);

// Drop binaries for any other DuckDB version. They can only mislead: the
// resolver looks under the current version and would never find them, and
// `npm pack` would ship them.
if (existsSync(extensionsDir)) {
  for (const entry of readdirSync(extensionsDir)) {
    if (entry.startsWith("v") && entry !== `v${version}`) {
      rmSync(join(extensionsDir, entry), { recursive: true, force: true });
      console.log(`removed stale ${entry}`);
    }
  }
}

const manifestPath = join(extensionsDir, "manifest.json");
const previous =
  existsSync(manifestPath) &&
  JSON.parse(readFileSync(manifestPath, "utf8")).duckdbVersion === version
    ? JSON.parse(readFileSync(manifestPath, "utf8")).platforms
    : {};
const manifest = { duckdbVersion: version, platforms: { ...previous } };

for (const platform of platforms) {
  const url = extensionUrl(version, platform, SQLITE_SCANNER);
  process.stdout.write(`fetching ${platform} ... `);
  const bytes = await fetchWithRetry(url);

  // A CDN error page is a 200 with HTML in it often enough to be worth ruling
  // out here rather than at LOAD time on a boat.
  let expanded;
  try {
    expanded = gunzipSync(bytes);
  } catch {
    console.log("");
    console.error(
      `${url} did not return a gzip stream (${bytes.length} bytes)`,
    );
    process.exit(1);
  }

  const target = join(ROOT, bundledExtensionRelPath(version, platform));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes);
  manifest.platforms[platform] = {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
    // What a complete expansion weighs. The runtime checks the cached file
    // against this instead of hashing 27 MB in every spawned query process.
    expandedBytes: expanded.length,
  };
  console.log(
    `${(bytes.length / 1e6).toFixed(1)} MB compressed, ` +
      `${(expanded.length / 1e6).toFixed(1)} MB expanded`,
  );
}

async function fetchWithRetry(url, attempts = 3) {
  let lastError = "";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      // Without a deadline a slow-drip CDN stalls on undici's multi-minute
      // default, inside `npm publish`.
      const response = await fetch(url, {
        signal: AbortSignal.timeout(120_000),
      });
      if (response.ok) return Buffer.from(await response.arrayBuffer());
      lastError = `${response.status} ${response.statusText}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    if (attempt < attempts) {
      process.stdout.write(`(${lastError}, retrying) `);
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    }
  }
  console.log("");
  console.error(`${url} failed after ${attempts} attempts: ${lastError}`);
  process.exit(1);
}

mkdirSync(versionDir, { recursive: true });
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(
  `\nDuckDB ${version}: ${Object.keys(manifest.platforms).sort().join(", ")}`,
);
