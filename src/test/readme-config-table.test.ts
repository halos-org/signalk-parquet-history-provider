import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigSchema } from "../config/schema.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * The README's configuration table is a copy of the schema, and copies drift.
 * An option added without a row is one an operator has no way to learn about
 * except by reading TypeScript.
 */
describe("the README configuration table", () => {
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");

  function titles(): string[] {
    const collected: string[] = [];
    for (const [name, property] of Object.entries(ConfigSchema.properties)) {
      const schema = property as any;
      if (schema.properties) {
        for (const sub of Object.values(schema.properties)) {
          collected.push((sub as any).title ?? name);
        }
        continue;
      }
      collected.push(schema.title ?? name);
    }
    return collected;
  }

  it("gives every schema field a title to be documented under", () => {
    for (const title of titles()) {
      assert.notEqual(title, undefined);
    }
  });

  it("has a row for every option the Admin UI renders", () => {
    for (const title of titles()) {
      // Prettier pads markdown table cells, so the row is matched rather than
      // compared: `| Filter mode      |`.
      const row = new RegExp(
        `^\\|\\s*${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\|`,
        "m",
      );
      assert.ok(
        row.test(readme),
        `README has no configuration row for "${title}"`,
      );
    }
  });
});
