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
    // Read without the `?? name` fallback: with it, every element is a string
    // by construction and the assertion cannot fail. A property that loses its
    // title otherwise degrades silently into being documented under its raw
    // key, and surfaces as a confusing missing-row failure elsewhere.
    for (const [name, property] of Object.entries(ConfigSchema.properties)) {
      const schema = property as any;
      const carried = schema.properties
        ? Object.values(schema.properties).map((sub: any) => sub.title)
        : [schema.title];
      for (const title of carried) {
        assert.equal(typeof title, "string", `${name} has no title`);
        assert.notEqual(title, "", `${name} has an empty title`);
      }
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
