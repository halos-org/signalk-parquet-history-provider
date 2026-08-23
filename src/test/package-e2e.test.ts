import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PLUGIN_ID } from "../plugin-id.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function packedFiles(): string[] {
  const output = execFileSync(
    "npm",
    ["pack", "--dry-run", "--json", "--ignore-scripts"],
    { cwd: ROOT, encoding: "utf8" },
  );
  const [entry] = JSON.parse(output) as { files: { path: string }[] }[];
  return entry.files.map((f) => f.path);
}

describe("the published package", () => {
  it("ships the compiled plugin and none of the sources", () => {
    const files = packedFiles();
    assert.ok(files.includes("dist/index.js"), "the entry point must ship");
    assert.ok(files.includes("package.json"));
    assert.ok(files.includes("LICENSE"));
    assert.ok(
      !files.some((f) => f.startsWith("src/")),
      "TypeScript sources must not ship",
    );
    assert.ok(
      !files.some((f) => f.startsWith("tools/")),
      "build scripts must not ship",
    );
  });

  it("ships the bundled DuckDB extension binaries, not just the manifest", () => {
    // The one thing .npmignore must not exclude. A device may have no network,
    // and without sqlite_scanner DuckDB cannot read the hot store at all.
    //
    // Asserted against a fixture rather than the repo's own extensions/: the
    // earlier version created a placeholder in the working tree, which wedges
    // the build gate if the process dies before its finally. The fixture also
    // lets this assert the case a prefix check misses -- an .npmignore glob
    // such as `*.gz` drops every binary while manifest.json still ships.
    const base = mkdtempSync(join(tmpdir(), "sk-parquet-pack-"));
    try {
      writeFileSync(
        join(base, ".npmignore"),
        readFileSync(join(ROOT, ".npmignore"), "utf8"),
      );
      writeFileSync(
        join(base, "package.json"),
        JSON.stringify({
          name: "fixture",
          version: "0.0.0",
          main: "dist/index.js",
        }),
      );
      mkdirSync(join(base, "dist"), { recursive: true });
      writeFileSync(join(base, "dist", "index.js"), "export default () => {};");
      const relative =
        "extensions/v9.9.9/linux_arm64/sqlite_scanner.duckdb_extension.gz";
      mkdirSync(dirname(join(base, relative)), { recursive: true });
      writeFileSync(join(base, relative), "binary");
      writeFileSync(join(base, "extensions", "manifest.json"), "{}");

      const output = execFileSync(
        "npm",
        ["pack", "--dry-run", "--json", "--ignore-scripts"],
        { cwd: base, encoding: "utf8" },
      );
      const [entry] = JSON.parse(output) as { files: { path: string }[] }[];
      const files = entry.files.map((f) => f.path);

      assert.ok(
        files.includes(relative),
        `the extension binary was not published: ${files.join(", ")}`,
      );
      assert.ok(files.includes("extensions/manifest.json"));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("declares the keyword Signal K discovers plugins by", () => {
    // Without it the server never looks at the package, however correct
    // everything else is.
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    assert.ok(pkg.keywords.includes("signalk-node-server-plugin"));
    assert.equal(pkg.main, "dist/index.js");
    assert.equal(pkg.type, "module");
  });

  it("declares an id matching the package name", () => {
    // Signal K keys the plugin's config file and its data directory off
    // plugin.id declared in code, while the app store derives an id from the
    // package name. Editing either alone strands every device's data on
    // upgrade, and nothing fails at build time.
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    assert.equal(PLUGIN_ID, pkg.name);
  });

  it("keeps VERSION and package.json on the same version", () => {
    // The release workflow reads VERSION; npm publishes package.json's. A
    // drift checks one number and publishes another.
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const version = readFileSync(join(ROOT, "VERSION"), "utf8").trim();
    assert.equal(pkg.version, version);
  });
});
