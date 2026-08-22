# AGENTS.md

Guidance for AI assistants working in this repository.

## Commands

- `npm run build` — `tsc` into `dist/`, then the bundled-extension gate
- `npm test` — the Node test runner against **compiled** output
  (`dist/test/**/*.test.js`). Build first; `npm run build:all` does both.
- `npm run format` — prettier write + `eslint --fix`
- `npm run ci-lint` — what CI checks
- Single test file: `node --test dist/test/bench-run.test.js` after a build

Node ≥ 22. `./run` lists everything with descriptions.

## What this is

A Signal K plugin that serves the history APIs out of Parquet files rather
than a database server. It is a peer alternative to
`signalk-questdb-history-provider`, selected per device. **Nothing in that
repository changes because of this one**, and no shared package is extracted —
the two history surfaces are copied and their query construction rewritten,
which is deliberate and recorded in
[halos-org/halos#152](https://github.com/halos-org/halos/issues/152).

The plan is that issue; the units are its sub-issues. Read the unit before
implementing it.

## The rule the design rests on

**The Signal K process does path filtering, rate capping and a socket write,
and no storage work whatsoever.** Everything else runs in its own process: the
writer owns the SQLite hot store, the roll is short-lived because DuckDB's
allocator does not return memory in-process, and each query is a spawned
DuckDB that exits.

So `src/index.ts` and everything it imports must never reach
`@duckdb/node-api`. One import undoes the plugin's entire reason to exist by
mapping a ~100 MB native addon into the server, and nothing else would fail.
`src/test/plugin-import-graph.test.ts` matches any `@duckdb/*` specifier — the
native addon lives in `@duckdb/node-bindings-<platform>`, not in the wrapper —
including `require()` and `createRequire` forms, and then starts the plugin in
a real process and checks what it mapped. The Signal K integration workflow
checks `/proc/<pid>/maps` on a running server. Do not weaken any of the three:
a lazily-loaded engine inside a query handler is the shape that would slip past
a check on module evaluation alone.

## Layout

- `src/index.ts` — the plugin the server loads. Currently registers, renders
  its schema and resolves the data directory; it records nothing yet.
- `src/config/schema.ts` — TypeBox. One source for both the Admin UI's JSON
  schema and the `Config` type. Add options here, and add a README row.
- `src/plugin-id.ts` — the id, in one place. It reappears as `plugin.id`, as
  the `handleMessage` sender and as the config filename; none of those
  mismatches fails at build time.
- `src/data-dir.ts` — resolves the configured directory once, in the plugin,
  because the spawned processes do not share the server's working directory.
- `src/path-matcher.ts`, `src/time-range.ts` — copied from
  `signalk-questdb-history-provider` with their suites. Fix bugs in both.
- `src/duckdb/` — version and platform naming, the bundled-extension resolver,
  and the standalone offline check. This is the only place that may import the
  engine.
- `src/bench/` — the measurement harness. Every unit that reports a number
  reports it through this, so figures stay comparable.

## Conventions

- TypeScript strict; do not loosen `tsconfig.json`.
- **Relative imports carry the `.js` extension** (`./config/schema.js`, from a
  `.ts` source). Node's ESM rule, enforced by `moduleResolution: "nodenext"`.
  Omitting it fails the build, which is the point — `"bundler"` resolution
  would emit unresolvable specifiers instead.
- The package is the unscoped `typebox` (1.x), not `@sinclair/typebox` (which
  stopped at 0.34). TypeBox 1 was published under a new name rather than a
  major bump, so `npm outdated` never points at it.
- `@duckdb/node-api` is pinned exactly, not by range. The bundled extension
  binary is built for one DuckDB version; a range lets an install move the
  engine out from under it, and the failure lands at `LOAD` on a device.
- `.npmignore` excludes by exact filename, so renaming a config file silently
  publishes it. It must never exclude `extensions/`.

## The bundled extension

`sqlite_scanner` is not statically linked into DuckDB and is not committed
here. `./run fetch-extensions` downloads it; `prepublishOnly` does the same
before packing. `tools/check-bundled-extensions.mjs` fails the build when the
bundle and the pinned engine disagree, when a binary is present that the
manifest does not describe, and — with `--strict` — when the published platform
set is incomplete. The scripts in `tools/` read the version, path and platform
rules from `dist/`, so they need a build first — that is on purpose, so those
rules exist once and are unit-tested.

`./run fetch-extensions` compiles with `tsc` directly rather than through
`npm run build`, which also runs that gate. The gate fails on a stale or
mismatched `extensions/` directory — the state the command exists to repair —
so routing through it would refuse to run the fix and then name the fix as the
remedy.

## Measurement

Numbers get reported with their spread, never as point estimates, and a
transient peak is never added to a steady-state figure. Rates divide by the
interval the clock measured, not the one that was requested. `src/bench/`
enforces the method; `./run bench selftest` compares the harness against a load
generator's own accounting of itself and exits non-zero when they disagree.
