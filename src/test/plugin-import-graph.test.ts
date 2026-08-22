import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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

const FORBIDDEN = "@duckdb/node-api";

function importedSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /(?:^|\n)\s*import\s+[^"';]*?from\s*["']([^"']+)["']/g,
    /(?:^|\n)\s*import\s*["']([^"']+)["']/g,
    /(?:^|\n)\s*export\s+[^"';]*?from\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
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
    assert.ok(
      !bare.has(FORBIDDEN),
      `dist/index.js reaches ${FORBIDDEN}. The Signal K process must not map ` +
        `the engine: spawn a process for the work instead.`,
    );
  });

  it("loads no DuckDB native library when a real process imports it", () => {
    // The static walk covers this package's own files. This covers everything
    // else — a dependency that pulls the addon in transitively would map it
    // just the same.
    const probe = [
      `await import(${JSON.stringify(pathToFileURL(ENTRY).href)});`,
      `const loaded = process.report.getReport().sharedObjects`,
      `  .filter((p) => /duckdb/i.test(p));`,
      `console.log(JSON.stringify(loaded));`,
    ].join("\n");
    const output = execFileSync(
      process.execPath,
      ["--input-type=module", "-e", probe],
      { encoding: "utf8" },
    );
    assert.deepEqual(JSON.parse(output.trim()), []);
  });
});
