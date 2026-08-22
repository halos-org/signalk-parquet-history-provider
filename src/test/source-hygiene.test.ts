import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * A literal NUL in a template string made git store `src/bench/report.ts` as a
 * binary file: no diffs, no line-ending normalisation, and nothing in the
 * build, the linter or the suites noticed, because the code ran correctly.
 * Zero-width spaces and other invisible characters fail the same way — they
 * survive review precisely because there is nothing to see.
 *
 * An escape sequence is how a control character belongs in source, so this
 * checks the bytes rather than what they mean.
 */
const FORBIDDEN = [
  { code: 0x00, name: "NUL" },
  { code: 0x08, name: "backspace" },
  { code: 0x0b, name: "vertical tab" },
  { code: 0x0c, name: "form feed" },
  { code: 0x1b, name: "escape" },
  { code: 0x200b, name: "zero-width space" },
  { code: 0x200c, name: "zero-width non-joiner" },
  { code: 0xfeff, name: "byte-order mark" },
  { code: 0x00a0, name: "non-breaking space" },
];

describe("tracked source files", () => {
  it("contain no invisible or control characters", () => {
    const files = execFileSync("git", ["ls-files"], {
      cwd: ROOT,
      encoding: "utf8",
    })
      .split("\n")
      .filter((f) => /\.(ts|mjs|js|json|md|yml|yaml)$/.test(f));
    assert.ok(files.length > 20, "expected to find the repo's tracked sources");

    const offences: string[] = [];
    for (const file of files) {
      const text = readFileSync(join(ROOT, file), "utf8");
      for (const { code, name } of FORBIDDEN) {
        const at = text.indexOf(String.fromCodePoint(code));
        if (at < 0) continue;
        const line = text.slice(0, at).split("\n").length;
        offences.push(`${file}:${line} contains a literal ${name}`);
      }
    }
    assert.deepEqual(offences, []);
  });

  it("are all text as far as git is concerned", () => {
    // The symptom, checked directly. `git ls-files --eol` reports `i/-text`
    // for a file git has decided is binary — which is what a stray NUL makes
    // a TypeScript file, costing it diffs and line-ending normalisation.
    const binary = execFileSync("git", ["ls-files", "--eol"], {
      cwd: ROOT,
      encoding: "utf8",
    })
      .split("\n")
      .filter((line) => line.includes("i/-text"))
      .map((line) => line.split("\t").at(-1));
    assert.deepEqual(binary, []);
  });
});
