import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * The plugin loads inside the Signal K process. The premise of the whole
 * design is that the process pays for path filtering, rate capping and a
 * socket write, and for no storage engine at all — `@duckdb/node-api` carries
 * a native addon of about 100 MB, and the writer, the roll and every query
 * run in separate processes precisely so the server never maps it.
 *
 * One `import` in the wrong file undoes that with no test failing anywhere
 * else, so this walks the compiled entry point's import graph and then checks
 * what a real process actually loads.
 */
const DIST = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = join(DIST, "index.js");

/**
 * Matched as a pattern, not as one exact string.
 *
 * `@duckdb/node-api` is the wrapper; the ~100 MB native addon and libduckdb
 * live in `@duckdb/node-bindings-<platform>`. A deep subpath, the bindings
 * package directly, or a future rename all carry the same cost and none of
 * them equals the wrapper's name.
 */
const FORBIDDEN = /(^|\/)@?duckdb/i;

function importedSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /(?:^|\n)\s*import\s+[^"';]*?from\s*["']([^"']+)["']/g,
    /(?:^|\n)\s*import\s*["']([^"']+)["']/g,
    /(?:^|\n)\s*export\s+[^"';]*?from\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    // createRequire is the documented way to reach CommonJS from ESM, and it
    // is how a lazily-loaded engine would most naturally arrive.
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1]);
  }
  return specifiers;
}

function walk(entry: string): { bare: Set<string>; files: string[] } {
  const bare = new Set<string>();
  const files: string[] = [];
  const queue = [entry];
  const seen = new Set<string>();

  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    files.push(file);
    for (const specifier of importedSpecifiers(readFileSync(file, "utf8"))) {
      if (specifier.startsWith(".")) {
        queue.push(resolve(dirname(file), specifier));
      } else if (!specifier.startsWith("node:")) {
        bare.add(specifier);
      }
    }
  }
  return { bare, files };
}

describe("the plugin's import graph", () => {
  it("never reaches the DuckDB engine", () => {
    assert.ok(existsSync(ENTRY), "build first: dist/index.js is missing");
    const { bare, files } = walk(ENTRY);
    assert.ok(files.length > 1, "expected the entry point to import something");
    const offenders = [...bare].filter((specifier) =>
      FORBIDDEN.test(specifier),
    );
    assert.deepEqual(
      offenders,
      [],
      `dist/index.js reaches ${offenders.join(", ")}. The Signal K process ` +
        `must not map the engine: spawn a process for the work instead.`,
    );
  });

  it("loads no DuckDB native library when a real process starts it", () => {
    // The static walk covers this package's own files. This covers everything
    // else — a dependency that pulls the addon in transitively would map it
    // just the same.
    // Importing the module is not enough: the factory it exports is what the
    // server calls, and a lazily-loaded engine inside start() would map
    // nothing until then. So this runs the plugin, against a throwaway data
    // directory, exactly as the server would.
    const work = mkdtempSync(join(tmpdir(), "sk-parquet-probe-"));
    const probe = [
      `import { mkdtempSync } from "node:fs";`,
      `const factory = (await import(${JSON.stringify(pathToFileURL(ENTRY).href)})).default;`,
      `const app = {`,
      `  debug() {}, error() {},`,
      `  setPluginStatus() {}, setPluginError() {},`,
      `  getDataDirPath: () => ${JSON.stringify(work)},`,
      `  selfContext: "vessels.self",`,
      `};`,
      `const plugin = factory(app);`,
      // Awaited: if start() ever becomes async and loads the engine lazily --
      // the case this test exists for -- an un-awaited call leaves the import
      // pending when the report is taken, and the probe reports nothing.
      `await plugin.start({});`,
      `await plugin.stop?.();`,
      `const loaded = process.report.getReport().sharedObjects`,
      `  .filter((p) => /duckdb/i.test(p));`,
      `console.log(JSON.stringify(loaded));`,
    ].join("\n");
    try {
      const output = execFileSync(
        process.execPath,
        ["--input-type=module", "-e", probe],
        // Bounded: a child that never exits would hang the whole suite with no
        // diagnostic, which is exactly how a /proc deadlock in another test
        // cost a CI run.
        { encoding: "utf8", timeout: 30_000 },
      );
      assert.deepEqual(JSON.parse(output.trim()), []);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
