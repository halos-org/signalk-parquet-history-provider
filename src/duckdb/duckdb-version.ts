/**
 * DuckDB version and platform naming, kept free of any DuckDB import.
 *
 * A DuckDB extension binary is built for exactly one DuckDB version and one
 * platform triple, and loading a mismatched one fails at `LOAD` on the device.
 * These helpers are what the build-time gate and the runtime resolver both
 * use to name the same file, so the two can never disagree about which binary
 * is the right one.
 */

/** The extension this package bundles. DuckDB links `parquet` and `json` in
 * statically; `sqlite_scanner`, which the roll and every query need to read
 * the hot store, it does not. */
export const SQLITE_SCANNER = "sqlite_scanner";

/**
 * The platforms the npm tarball carries: the HaLOS device target, plus x86
 * Linux for CI and development.
 *
 * Here, not in the scripts, because the fetcher's default and the publish
 * gate's requirement are one rule. Two copies can disagree in the direction
 * that is silent — a platform fetched but not required means removing it from
 * the fetch list still passes `--strict`, and publishes a tarball with no
 * binary for a device that used to have one.
 */
export const PUBLISHED_PLATFORMS = ["linux_arm64", "linux_amd64"] as const;

/** Whether a dependency spec is an exact pin. A range would let an install
 * move the engine away from the bundled extension binary. */
export function isExactPin(spec: string): boolean {
  return /^\d+\.\d+\.\d+(-r\.\d+)?$/.test(spec.trim());
}

/**
 * `@duckdb/node-api` publishes one npm version per DuckDB release plus a
 * revision suffix — `1.5.5-r.4` wraps DuckDB `1.5.5`. The extension
 * repository is keyed by the DuckDB version, so the suffix has to come off.
 *
 * Verified rather than assumed: tools/fetch-extensions.mjs asserts this
 * against `select version()` from the installed binding, where paying for a
 * DuckDB instance is free. Everything else trusts the parse.
 */
export function duckdbVersionFromPackageVersion(
  packageVersion: string,
): string {
  const match = /^(\d+\.\d+\.\d+)(?:-r\.\d+)?$/.exec(packageVersion.trim());
  if (!match) {
    throw new Error(
      `Cannot read a DuckDB version out of @duckdb/node-api version "${packageVersion}"`,
    );
  }
  return match[1];
}

export interface PlatformInput {
  platform: NodeJS.Platform;
  arch: string;
  musl: boolean;
}

/**
 * DuckDB's platform triple, as it appears in the extension repository path.
 * Unknown combinations throw rather than guess: a wrong triple downloads a
 * binary that cannot load, and the error surfaces far from here.
 */
export function duckdbPlatform({
  platform,
  arch,
  musl,
}: PlatformInput): string {
  const cpu = arch === "arm64" ? "arm64" : arch === "x64" ? "amd64" : null;
  if (cpu === null) {
    throw new Error(`DuckDB publishes no extensions for arch "${arch}"`);
  }
  if (platform === "linux") return musl ? `linux_${cpu}_musl` : `linux_${cpu}`;
  if (platform === "darwin") return `osx_${cpu}`;
  throw new Error(`DuckDB publishes no extensions for platform "${platform}"`);
}

/**
 * True on a musl libc (Alpine and friends). DuckDB ships separate musl
 * builds, and a glibc binary on musl fails at `LOAD` with a dynamic-linker
 * error that names neither libc. Node reports the runtime glibc version in
 * its diagnostic report; the field is simply absent on musl.
 */
export function detectMusl(): boolean {
  const header = process.report?.getReport() as
    { header?: { glibcVersionRuntime?: string } } | undefined;
  return process.platform === "linux" && !header?.header?.glibcVersionRuntime;
}

/** This process's own triple. */
export function currentDuckdbPlatform(): string {
  return duckdbPlatform({
    platform: process.platform,
    arch: process.arch,
    musl: detectMusl(),
  });
}

/**
 * Where a bundled extension lives inside the package, relative to its root.
 * Version-keyed so a stale binary from an earlier DuckDB cannot be mistaken
 * for the current one — it simply is not found.
 */
export function bundledExtensionRelPath(
  duckdbVersion: string,
  platform: string,
  extension: string = SQLITE_SCANNER,
): string {
  return `extensions/v${duckdbVersion}/${platform}/${extension}.duckdb_extension.gz`;
}

/** The upstream URL for one extension binary. */
export function extensionUrl(
  duckdbVersion: string,
  platform: string,
  extension: string = SQLITE_SCANNER,
): string {
  return `https://extensions.duckdb.org/v${duckdbVersion}/${platform}/${extension}.duckdb_extension.gz`;
}
