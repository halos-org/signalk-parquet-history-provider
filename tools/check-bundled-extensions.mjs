#!/usr/bin/env node
/**
 * Build gate for the bundled DuckDB extensions.
 *
 * An extension binary is built for exactly one DuckDB version and one platform
 * triple. A mismatch produces no build error and no install error — it fails
 * at `LOAD`, on the device, in a query. This turns that into a failed build.
 *
 *   node tools/check-bundled-extensions.mjs             # after `tsc`
 *   node tools/check-bundled-extensions.mjs --strict   # before publishing
 *
 * Without `--strict`, an absent extensions/ directory passes: a clone builds
 * and tests fine without 16 MB of binaries. With it, the published platform
 * set must be complete — that is the form the release workflow runs.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REQUIRED_PLATFORMS = ["linux_arm64", "linux_amd64"];
const strict = process.argv.includes("--strict");

const fail = (message) => {
  console.error(`bundled extensions: ${message}`);
  process.exit(1);
};

const { bundledExtensionRelPath, duckdbVersionFromPackageVersion } =
  await import(join(ROOT, "dist", "duckdb", "duckdb-version.js"));

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const spec = pkg.dependencies?.["@duckdb/node-api"];
if (!spec) fail("package.json does not depend on @duckdb/node-api");
if (!/^\d+\.\d+\.\d+(-r\.\d+)?$/.test(spec)) {
  fail(
    `@duckdb/node-api is "${spec}", a range. It must be pinned exactly: a ` +
      `range lets an install move the engine away from the bundled extension.`,
  );
}
const version = duckdbVersionFromPackageVersion(spec);

const extensionsDir = join(ROOT, "extensions");
const manifestPath = join(extensionsDir, "manifest.json");
if (!existsSync(manifestPath)) {
  if (strict) {
    fail(
      `no extensions/manifest.json. Run \`npm run fetch-extensions\` before ` +
        `publishing — a device with no network cannot read the hot store ` +
        `without them.`,
    );
  }
  console.log(
    `bundled extensions: none present (DuckDB ${version} expected). ` +
      `\`./run fetch-extensions\` downloads them; publishing requires them.`,
  );
  process.exit(0);
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (manifest.duckdbVersion !== version) {
  fail(
    `extensions/ holds DuckDB ${manifest.duckdbVersion} binaries but ` +
      `@duckdb/node-api@${spec} is DuckDB ${version}. ` +
      `Run \`./run fetch-extensions\`.`,
  );
}

for (const entry of readdirSync(extensionsDir)) {
  if (entry.startsWith("v") && entry !== `v${version}`) {
    fail(`extensions/${entry} is stale. Run \`./run fetch-extensions\`.`);
  }
}

for (const [platform, expected] of Object.entries(manifest.platforms)) {
  const path = join(ROOT, bundledExtensionRelPath(version, platform));
  if (!existsSync(path)) {
    fail(`manifest lists ${platform} but ${path} is missing.`);
  }
  const bytes = readFileSync(path);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== expected.sha256) {
    fail(`${platform} does not match its manifest checksum.`);
  }
}

if (strict) {
  const missing = REQUIRED_PLATFORMS.filter((p) => !manifest.platforms[p]);
  if (missing.length > 0) {
    fail(`the published set is missing ${missing.join(", ")}.`);
  }
}

console.log(
  `bundled extensions: DuckDB ${version}, ` +
    `${Object.keys(manifest.platforms).sort().join(", ")}`,
);
