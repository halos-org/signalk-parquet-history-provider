import { defineConfig, globalIgnores } from "eslint/config";
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier/flat";
import globals from "globals";

export default defineConfig([
  // .worktrees holds full checkouts, each with its own tsconfig.json.
  // Without this, typescript-eslint refuses every source file in the
  // outer clone with "multiple candidate TSConfigRootDirs". .gitignore
  // does not cover it -- flat config does not read that file.
  globalIgnores(["dist", "extensions", "node_modules", ".worktrees"]),

  {
    files: ["**/*.ts"],
    extends: [js.configs.recommended, tseslint.configs.recommended, prettier],
    languageOptions: {
      parser: tseslint.parser,
      globals: globals.node,
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      // tsconfig has no noUnusedLocals, so this is the only thing in the
      // repo that reports an import or helper left behind by a deletion.
      "@typescript-eslint/no-unused-vars": "error",
    },
  },

  // tools/ is plain ESM JavaScript, run by node directly rather than compiled.
  // It exists so the extension fetch and version check work before (and
  // without) a tsc build.
  {
    files: ["tools/**/*.mjs"],
    extends: [js.configs.recommended, prettier],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: globals.node,
    },
  },
]);
