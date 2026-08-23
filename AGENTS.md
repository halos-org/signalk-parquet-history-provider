# AGENTS.md

Guidance for AI assistants working in this repository.

## Commands

- `npm run build` — `tsc` into `dist/`, then the bundled-extension gate
- `npm test` — the Node test runner against **compiled** output
  (`dist/test/**/*.test.js`). Build first; `npm run build:all` does both.
- `npm run format` — prettier write + `eslint --fix`
- `npm run ci-lint` — what CI checks
- Single test file: `node --test dist/test/bench-run.test.js` after a build

Node ≥ 22.13.0. That floor is `node:sqlite`, not a preference: it needs
`--experimental-sqlite` below 22.13.0, and the writer imports it unflagged. The
API is identical on 22, 24 and 26 — checked on all three rather than assumed.

`./run` lists everything with descriptions.

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
`@duckdb/node-api` — nor `node:sqlite`, which is a native module and would
put a database handle and its WAL in the server's heap. One import undoes the
plugin's entire reason to exist by mapping a ~100 MB native addon into the
server, and nothing else would fail.
`src/test/plugin-import-graph.test.ts` matches any `@duckdb/*` specifier — the
native addon lives in `@duckdb/node-bindings-<platform>`, not in the wrapper —
including `require()` and `createRequire` forms, and then starts the plugin in
a real process and checks what it mapped. The Signal K integration workflow
checks `/proc/<pid>/maps` on a running server. Do not weaken any of the three:
a lazily-loaded engine inside a query handler is the shape that would slip past
a check on module evaluation alone.

## Layout

- `src/index.ts` — the plugin the server loads. Subscribes to the delta bus,
  spawns the writer process, and reports what is happening in the status line.
- `src/recorder.ts` — the whole of the Signal K process's involvement: path
  filter, rate cap, cardinality cap, and a sample handed onwards.
- `src/flush-buffer.ts` — what is held between flushes. Bounded in **bytes**,
  not elements, and the bytes are measured by serialising rather than
  estimated, because JSON escaping can expand a value sixfold and an estimate
  below the truth makes the ceiling fictional.
- `src/writer/` — the writer process and the socket to it. `main.ts` is its
  entry point and must never be imported by the plugin; `contract.ts` holds the
  exit codes and paths both sides need, which is why it exists at all.
- `src/config/schema.ts` — TypeBox. One source for both the Admin UI's JSON
  schema and the `Config` type. Add options here, and add a README row.
- `src/plugin-id.ts` — the id, in one place. It reappears as `plugin.id`, as
  the `handleMessage` sender and as the config filename; none of those
  mismatches fails at build time.
- `src/data-dir.ts` — resolves the configured directory once, in the plugin,
  because the spawned processes do not share the server's working directory.
- `src/delta-routing.ts` — copied from `signalk-questdb-history-provider` with
  its suite. Routing behaviour is identical and must stay that way: it decides
  what a position query returns, and Unit 4c reproduces that provider's history
  contract. Only the comments were retargeted, from its three QuestDB tables to
  this store's `value_kind` column. Fix bugs in both.
- `src/path-matcher.ts`, `src/time-range.ts` — copied from
  `signalk-questdb-history-provider` with their suites. Fix bugs in both.
  They currently **differ** from the sibling by three fixes: `resolveTimeRange`
  treats a zero duration as a value rather than as absent, `Throttle` tests a
  pair for presence rather than using a `0` sentinel, and `Throttle` treats a
  backwards clock step as a discontinuity rather than as a sample arriving too
  soon — without that, a device whose clock is stepped at boot stops recording
  for the length of the step. The sibling is tracked
  at
  [signalk-questdb-history-provider#23](https://github.com/halos-org/signalk-questdb-history-provider/issues/23).
- `src/duckdb/` — version and platform naming, the bundled-extension resolver,
  and the standalone offline check. This is the only place that may import the
  engine.

- `src/bench/` — the measurement harness. Every unit that reports a number
  reports it through this, so figures stay comparable.
- `docs/layout-decision.md` — what the roll writes, how often, and why: one
  Parquet file per roll under a dated directory, no path partitioning, no
  compaction pass, plus a last-value sidecar. Read it before touching the roll
  or the reader; the measurements behind each choice are in it, and so is what
  would reopen one.

## The writer

One writer process per plugin run, spawned by the plugin. **Its listening
socket is the claim on the hot store**: a writer that finds something answering
on the socket path refuses to start and exits `EXIT_LOCKED`, and a socket file
nothing answers on is a leftover to take over.

The claim matters because SQLite will not make it: SQLite takes per-transaction
locks rather than per-handle ones, so two writers would both open the file and
interleave their rows and their sequence numbers. `PRAGMA locking_mode =
EXCLUSIVE` would prevent that and is unavailable, because it also blocks
readers, and the roll reading the store while the writer holds it is why the
store is SQLite at all.

A pid file is the obvious alternative and is wrong here: a pid means nothing
across the PID namespaces a container restart creates, so a stale lock names an
unrelated live process and refuses every later writer, permanently.
`writer.pid` is still written, for whoever is reading the device, and nothing
decides anything from it.

The socket is a Unix domain socket in a `0700` directory, mode `0600` — never
a TCP port, not even on loopback, which is shared with every local process and
container in the namespace. Node exposes no way to read peer credentials
without a native addon, so filesystem permission is the enforcement.

The server serves one client at a time. The store's session and sequence
counter are process-global, so a second connection moving them is enough to
make every batch on the first skip as a duplicate — acknowledged, never
written. A new session therefore closes the incumbent, and a second `hello` on
an established connection is refused.

A batch carries a sequence number, and the writer skips one it has already
committed. That is what makes a resend after a lost acknowledgement
idempotent, and it is scoped by a session id from the handshake: the plugin's
counter restarts at 1 when the plugin does, so without the session a writer
outliving its plugin would discard the new run's batches as duplicates of the
old run's, acknowledge them, and record nothing while reporting healthy.

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
