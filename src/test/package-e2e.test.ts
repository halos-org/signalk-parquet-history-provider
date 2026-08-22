import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

  it("ships the bundled DuckDB extensions", () => {
    // The one thing .npmignore must NOT exclude. A device may have no
    // network, and without sqlite_scanner DuckDB cannot read the hot store at
    // all — so an npmignore edit that swallows this directory breaks every
    // install, silently, at query time.
    const placeholder = join(
      ROOT,
      "extensions",
      "v0.0.0-test",
      "linux_arm64",
      "sqlite_scanner.duckdb_extension.gz",
    );
    const created = !existsSync(placeholder);
    if (created) {
      mkdirSync(dirname(placeholder), { recursive: true });
      writeFileSync(placeholder, "placeholder");
    }
    try {
      const files = packedFiles();
      assert.ok(
        files.some((f) => f.startsWith("extensions/")),
        "extensions/ must be published even though it is gitignored",
      );
    } finally {
      if (created) {
        rmSync(join(ROOT, "extensions", "v0.0.0-test"), {
          recursive: true,
          force: true,
        });
      }
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

  it("keeps VERSION and package.json on the same version", () => {
    // The release workflow reads VERSION; npm publishes package.json's. A
    // drift checks one number and publishes another.
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const version = readFileSync(join(ROOT, "VERSION"), "utf8").trim();
    assert.equal(pkg.version, version);
  });
});
