# What a query costs

What a history query costs on the device, measured through the shipped reader
rather than through an ad-hoc statement, and what follows from the figures.
`docs/layout-decision.md` is its counterpart for what the roll writes; the plan
both belong to is
[halos-org/halos#152](https://github.com/halos-org/halos/issues/152).

## The shape

One query service, started on the first history request and kept until the
plugin stops. It answers one request at a time; the plugin queues the rest.

It is a separate process because `@duckdb/node-api` maps a ~100 MB native addon
and DuckDB does not return what a query allocates — neither belongs in the
process serving the vessel's data. It stays alive because starting it costs
more than answering anything.

One request compiles to one statement: the tree files whose date directory
intersects the range, unioned with the unrolled remainder of the hot store.
Nothing prunes on `path` — the tree carries time as directories and everything
else as columns — so a range is a directory selection plus a `ts` filter.

## The floor, paid once

Three runs each, on a HALPI2 (4 GB, aarch64, DuckDB 1.5.5, Node 22.23.2):

| up to and including         | ms            |
| --------------------------- | ------------- |
| node starts                 | 26, 26, 29    |
| `import @duckdb/node-api`   | 251, 255, 218 |
| instance created, connected | 265, 266, 269 |
| `LOAD sqlite_scanner`       | 375, 353, 336 |

**Mapping the engine's native addon is ~220 ms of it**, and nothing in this
design avoids that. Loading the extension is another ~80 ms. Together they are
why the service exists: a process per query spent six times longer starting
than answering.

The hot store is attached per query rather than at startup, which costs
0.2–1.2 ms against the live 264 MB store and buys two things — a store that did
not exist when the service started is picked up, and no SQLite handle is held
between queries. Neither was strictly necessary: measured across processes, a
held attachment still sees rows written after it, and the writer's
`wal_checkpoint(TRUNCATE)` still truncates to zero with `busy: 0` while it is
held. It is a millisecond for one less thing to reason about.

## What a query costs

Against the live data directory — 10 roll files under one date, and a hot store
holding about half an hour — driven through `./run bench query`, which uses the
same client the plugin does. Wall clock is request to answer.

| query                       | first request | later requests | rows   |
| --------------------------- | ------------- | -------------- | ------ |
| one path, one day           | 652 ms        | 215–246 ms     | 6,501  |
| one path, last hour         | 529–558 ms    | 135–175 ms     | 1,664  |
| paths in the day            | 450 ms        | 96–117 ms      | 524    |
| every path, last 10 minutes | 1,576 ms      | 1,158–1,244 ms | 81,687 |

Over forty consecutive hour-long queries the warm figure is a median of 148 ms,
between 135 and 242.

**Against the plan's criterion — sqhp's ~34 ms for an hour-long request — this
is four to five times slower, where a process per query was fifteen.** What is
left is not startup. The same statement on an already-open engine, without the
pipe or the request's own planning, runs in 39–45 ms; the rest is serialising
1,664 rows to JSON, the pipe, and parsing them back. That is where to look next
if the number has to come down again.

Nothing here changes the memory case the design was chosen for: QuestDB's
standing cost is ~366 MB.

## What the service holds

It reports its own resident size with every answer, because a process that
stays is judged on what it holds as well as on what it takes.

| after                                     | service RSS |
| ----------------------------------------- | ----------- |
| started, nothing asked                    | 92 MB       |
| one single-path hour                      | 117 MB      |
| fifteen of them                           | 164 MB      |
| forty of them                             | 170 MB      |
| one all-paths ten-minute query (82k rows) | 317 MB      |

So repeated work converges rather than leaking — 117 to 164 MB over fifteen
queries, then 6 MB over the next twenty-five. What it does not do is come back
down: the service settles at the high-water mark of the largest shape it has
been asked for. With the writer at 87 MB, a service that has answered a few
queries puts the plugin's standing cost near 260 MB, against the 150 MB this
project set itself and QuestDB's ~366 MB.

Bounding that is
[halos-org/halos#178](https://github.com/halos-org/halos/issues/178): recycle
the service on an idle timeout, an RSS ceiling, or both. Until then it is one
process for the life of the plugin, and this is what that costs.

## The layout decision, re-checked

`docs/layout-decision.md` chose one file per roll, no path partitioning and no
compaction, and named what would reopen it: a multi-day query dominated by
per-file cost rather than by startup.

Both trees below are one day of real data hard-linked into 30 dated
directories, with no hot store. The rows therefore repeat, and a 30-day range
returns 30× the rows — so these numbers overstate the row cost of a real 30-day
window and measure the file cost honestly. Each figure includes one engine
start: they were taken before the service existed, with a process per query.

| tree                   | files | one path, 30 days           | paths, 30 days      | one path, one day |
| ---------------------- | ----- | --------------------------- | ------------------- | ----------------- |
| roll files (8 per day) | 240   | 2,195–2,244 (e 1,836–1,892) | 661–727 (e 381–438) | 360–435           |
| compacted (1 per day)  | 30    | 1,916–2,062 (e 1,579–1,746) | 601–631 (e 339–367) | 375–444           |

**Per-file planning cost is about 1 ms.** Collapsing 240 files into 30 saves
~230 ms of a 2,200 ms query and ~60 ms of a 660 ms one. The 30-day query is
dominated by its 82,590 rows, not by its files, so the condition for reopening
compaction is not met. Compacting one day cost 639 ms in a process measured
there at 344–484 MB — the largest transient in the design — to save 230 ms on a
query nobody has to make.

**A date-scoped query does not care how large the tree is.** 1 file, 8 files
and 240 files all answer a one-day single-path range in 360–444 ms. That is the
property the layout was chosen for, and it is the reason a long-range query
stays avoidable rather than fast.

So the decision stands: no compaction pass, no path partitioning. What would
reopen it is a _real_ thirty-day tree — 720 files at hourly rolls — where the
same per-file slope predicts ~720 ms of planning. That is worth re-measuring
once a device has one, and it is not worth pre-emptively engineering for.

`getPaths` is a scan rather than a directory listing, and the flat layout is
why. The cumulative sidecar could answer "every path ever" from one 11 kB file,
but not "every path with data in this range", which is what the history API
asks. Nothing reads the sidecar.

## The seam

A roll writes its rows to Parquet, and the writer deletes them from the hot
store afterwards. Between those two steps every covered row is in both places,
and after a failed truncate it stays that way until the writer restarts.

The reader subtracts one copy exactly. It lists the tree's files first and
reads the pending-roll record second, then excludes from the hot store the rows
`rowid <= maxRowid` whose own UTC day has a file named for that roll. Anchoring
on the file list rather than on the record is what makes the race safe in the
direction that matters: a record naming a roll whose file has not appeared yet
subtracts nothing, so a duplicate is never turned into a gap. A roll killed
between two date directories is handled by the same rule — the day it wrote is
subtracted and the day it did not is not.

`DISTINCT` over the answer was the alternative. It would cost a sort over every
range and would also collapse two genuinely identical samples, which the
sibling provider's QuestDB tables do by dedup key but this store does not.

## Concurrency, and what can overlap

The service answers one request at a time: two queries on one connection would
interleave their rows on one pipe, and at 96–246 ms each a queue is a better
answer than a second engine. Eight may wait; past that a request is refused
rather than queued behind requests that will not be served in time either. The
deadline is 30 seconds and covers the wait as well as the work.

A query that overruns it costs the service — the engine cannot be interrupted
from the plugin's side — and the next request starts a new one. A query that
_fails_ costs only the request; the engine is worth more than one answer.

**Nothing coordinates a query with a roll.** The roll runs on the writer's
schedule and a query arrives when a client asks, so the worst case is the sum
of peaks measured apart: a service that has served a large query at ~320 MB and
a roll at 163 MB, so under 500 MB. That fits a 4 GB device running the marine
stack, which is why nothing admission-controls the two against each other.

A query returns at most 100,000 rows and says so when it truncated, because the
Signal K process holds the whole answer to serialise it — the row limit is a
ceiling on that process, not on this one.

## What this does not measure

- **Aggregation.** The reader returns raw rows. Bucketed aggregates belong to
  the v2 surface, and nothing here prices them.
- **A concurrent roll and query.** The figure above is arithmetic.
- **A tree with a real retention window in it.** Both aged trees are one day of
  data wearing thirty dates.
- **A service across days rather than minutes.** The plateau above is forty
  queries of one shape; what a week of mixed use settles at is
  [#178](https://github.com/halos-org/halos/issues/178)'s to answer.
- **A file deleted while a query reads it.** The file list is taken before the
  statement runs, so whatever ships expiry has to decide what a reader already
  holding a list should see.
