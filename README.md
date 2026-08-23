# signalk-parquet-history-provider

A Signal K history provider that stores data in Parquet files instead of a
database server. Deltas go to a SQLite hot store owned by a separate writer
process; a short-lived roll turns that store into a Parquet tree; queries run
in a spawned DuckDB that reads the tree and the hot store together.

It is an alternative to
[`signalk-questdb-history-provider`](https://github.com/halos-org/signalk-questdb-history-provider),
chosen per device. The two are not meant to run on one device, and this plugin
changes nothing about that one. The reason to want it is the resource floor:
QuestDB costs a JVM at about 366 MB resident, 24 hours a day, whether or not
anyone queries it.

## Status

Recording and rolling work: the plugin filters, rate-caps and buffers, a
separate writer process owns a SQLite hot store, and the writer rolls that
store into a Parquet tree on a schedule and truncates it. The query layer and
the two history API surfaces are not implemented yet, so nothing reads this
data back yet. Progress is tracked in
[halos-org/halos#152](https://github.com/halos-org/halos/issues/152).

## The tree

    <data directory>/
      hot/hot.sqlite            the writer's store, truncated after each roll
      parquet/date=YYYY-MM-DD/  one file per roll, named for the slot it ran in
      latest/latest.parquet     every path's last value, cumulative

`context` and `path` are columns, never directories, and each row lands under
the date its own timestamp names — so a roll spanning midnight writes two
files. Why it is shaped this way, with the measurements behind it, is
`docs/layout-decision.md`.

## Installation

Not published yet. Once it is, it installs from the Signal K app store or with
`npm install signalk-parquet-history-provider` into the server's plugin
directory.

## Configuration

Every option is rendered in the Signal K Admin UI from the plugin's own schema
(`src/config/schema.ts`), which is also the source of the `Config` type.

| Option                                              | Default               | What it does                                                                                                                                                                                                                  |
| --------------------------------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Filter mode                                         | `exclude`             | Whether the path patterns below name what to skip or what to keep.                                                                                                                                                            |
| Path patterns (glob supported)                      | none                  | Globs over Signal K paths, e.g. `notifications.*`.                                                                                                                                                                            |
| Default sampling rate (ms)                          | `2000`                | Minimum interval between recorded samples for a path. `0` records every update.                                                                                                                                               |
| Per-path sampling rates (ms)                        | none                  | Overrides for individual paths or globs.                                                                                                                                                                                      |
| Record own vessel                                   | on                    | Whether `vessels.self` is recorded.                                                                                                                                                                                           |
| Record other vessels                                | **off**               | Whether AIS targets and other vessels are recorded. Off by default because every vessel is a context, and the roll holds one Parquet writer per partition — this setting, more than data volume, sets the roll's memory peak. |
| Maximum distinct recorded paths                     | `2000`                | Paths beyond this are ignored, so a misbehaving source cannot inflate the partition count without limit.                                                                                                                      |
| Maximum distinct recorded contexts                  | `100`                 | The same bound for vessel contexts.                                                                                                                                                                                           |
| Flush interval (ms)                                 | `5000`                | No sample waits longer than this before reaching the writer. Also the crash-loss window: a hard power cut loses at most this much.                                                                                            |
| Flush batch size (samples)                          | `1000`                | Samples per write, whichever comes first with the interval. Each batch is one SQLite transaction.                                                                                                                             |
| Buffer ceiling while the writer is unreachable (MB) | `8`                   | Memory held for samples that could not be sent. When full the oldest are dropped and the count is reported in the plugin status.                                                                                              |
| Data directory                                      | plugin data directory | Where the hot store and the Parquet tree live. A relative value resolves against the plugin's own directory.                                                                                                                  |
| Retention (days, 0 = keep forever)                  | `0`                   | How long data is kept.                                                                                                                                                                                                        |
| Roll interval (minutes)                             | `60`                  | How often the hot store becomes Parquet and is truncated. Shorter keeps the hot store small at the cost of more Parquet files. Must divide 1440; the schedule runs every N minutes from UTC midnight.                         |

## The bundled DuckDB extension

DuckDB links `parquet` and `json` in statically but not `sqlite_scanner`, and
without that extension it cannot read the hot store at all. A device may have
no network, so the published package carries the binary rather than letting
DuckDB download one — autoinstall and autoload are both disabled, which also
keeps a query from fetching and running a binary from the internet.

The binaries are **not committed**: they are about 8 MB each and would land in
the history again on every DuckDB bump. `./run fetch-extensions` downloads
them into `extensions/` for development, and `prepublishOnly` does the same
before packing, so the npm tarball always has them. The published set is
`linux_arm64` (the device) and `linux_amd64` (CI and x86 development);
anything else is one `./run fetch-extensions <triple>` away.

An extension binary is built for exactly one DuckDB version and one platform,
and a mismatch fails at `LOAD` rather than at install. Three things keep that
from reaching a device: `@duckdb/node-api` is pinned exactly rather than by
range, `npm run build` refuses a bundle whose manifest names a different
version, and CI loads the real binary on both architectures inside a container
with no network.

To check an installation on the machine it runs on:

```bash
./run check-extension          # in a clone
node dist/duckdb/check-extension.js   # in an installed copy on a device
```

It creates a DuckDB, loads the bundled extension, attaches a SQLite file,
writes rows and reads them back.

## The measurement harness

Every unit that reports a number reports it through `src/bench/`, so the
figures are comparable across units and against the QuestDB baseline. The
method: settle, then N windows, each differenced end to end for its rate and
split in half to check that it measured a steady state rather than a
transition. Rates divide by the interval the clock actually measured, never by
the requested window length — those differ under load, and by more in the
condition being tested than in the control it is compared against.

Memory is sampled through the window instead, and its peak is reported apart
from its mean: a transient peak and a 24-hour cost are different quantities,
and adding them produces a number that describes nothing. The peak comes from
the kernel's own high-water mark (`VmHWM`, or cgroup `memory.peak`) rather than
from the samples, because the roll process is short-lived by design and its
peak is exactly what a sampling interval misses.

That method needs a subject that is still running, which a roll is not: it
lives seconds, has no steady state, and is gone before a window closes. `roll`
measures one instead, by asking the roll process for the high-water mark the
kernel kept for it and polling `/proc` from outside as a cross-check. **Point
it at a copy of a data directory** — a roll writes into the tree and does not
truncate the hot store, so one run beside a live writer puts those rows in the
tree twice. It refuses if anything answers on the writer's socket.

```bash
./run bench run --label sqhp --subject signalk:pid=1234 -o sqhp.json
./run bench compare control.json sqhp.json parquet.json
./run bench selftest
./run bench roll --data-dir /path/to/a/copy --max-rowid 1267241
```

`selftest` measures a load generator with a known duty cycle and compares the
harness's numbers against the generator's own accounting — it counted the bytes
it fsynced and asked the kernel for its own CPU time, so those are ground truth
and a disagreement beyond 15% fails the command. It reads `/proc` and cgroup
counters, so it only runs on Linux.

## Development

```bash
./run            # list the commands
./run test       # build, then run the suites
./run lint
./run ci         # what CI runs, in CI's order
```

Requires Node 22 or newer.

## License

MIT. Copyright (c) 2026 Hat Labs Oy.
