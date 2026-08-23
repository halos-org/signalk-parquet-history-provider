# What a query costs

Unit 4a of [halos-org/halos#152](https://github.com/halos-org/halos/issues/152):
the execution layer, and what it measures on the device. Unit 3a priced these
queries with ad-hoc statements and said every figure in it was provisional
until a real reader ran them. This is that reader.

## The shape

One HTTP request compiles to one statement in one spawned process. The process
exits, which is what keeps ~120 MB of engine from becoming a standing cost
inside the Signal K server, and it is also what sets the floor below.

The statement unions the tree files whose date directory intersects the range
with the unrolled remainder of the hot store. Nothing prunes on `path`: the
tree carries time as directories and everything else as columns, so a range is
a directory selection plus a `ts` filter.

## The floor

Every spawned query pays this before it reads a row. Three runs each, on a
HALPI2 (4 GB, aarch64, DuckDB 1.5.5, Node 22.23.2):

| up to and including         | ms            |
| --------------------------- | ------------- |
| node starts                 | 26, 26, 29    |
| `import @duckdb/node-api`   | 251, 255, 218 |
| instance created, connected | 265, 266, 269 |
| `LOAD sqlite_scanner`       | 375, 353, 336 |
| `ATTACH` the hot store      | 374, 384, 341 |

**Mapping the engine's native addon is ~220 ms of it.** Nothing in this design
can avoid that: the addon is why the query runs in its own process, and the
process is why the memory is transient. Loading `sqlite_scanner` is another
~80 ms, which is why the reader loads it only when there is a hot store to
attach — a range old enough to sit entirely in the tree needs no SQLite.

So the floor is **~265 ms for a tree-only query and ~345 ms when the hot store
is in range**, on this device, before any work.

## What a query costs on top

Against the live data directory: 8 roll files under one date, and a hot store
holding about half an hour. Wall clock is spawn to answer — the figure a
request actually pays. `engine` is the query process's own timing, which
excludes its own startup and is reported only so the difference stays visible.

| query                         | wall (ms)   | engine (ms) | rows    | peak (MB) |
| ----------------------------- | ----------- | ----------- | ------- | --------- |
| one path, one day, tree + hot | 610–612     | 348–350     | 3,745   | 126–127   |
| one path, last hour           | 526–684     | 262–427     | 1,623   | 118–119   |
| every path, last 10 minutes   | 1,548–1,665 | 1,233–1,309 | ~82,000 | 218–221   |
| paths in the day              | 448–486     | 190–224     | 519     | 112–114   |
| contexts in the day           | 447–516     | 155–218     | 1       | 110–111   |
| a range with no data          | 464–506     | 201–225     | 0       | 102–104   |

**The plan's query criterion is not met, and cannot be by this shape.** It asks
for a single-path range "within sqhp's range (~34 ms for an hour-long
request)". The measured answer is 526–684 ms, of which ~345 ms is the floor
above. Unit 3a's 16–37 ms was in-engine time for a statement in an
already-running process, which is what the unit issue suspected. A history
provider that spawns per query answers in half a second; one that talks to a
running server answers in tens of milliseconds. That is the trade the design
makes for not having a database server resident, and it is now a measurement
rather than an estimate.

Nothing here changes the memory case: an idle QuestDB is ~366 MB standing,
while this is 0 MB standing and ~120 MB for as long as a query runs.

## The layout decision, re-checked

Unit 3a chose one file per roll, no path partitioning and no compaction, and
named what would reopen it: "if Unit 4a's real reader shows a multi-day query
dominated by per-file cost rather than by startup."

Both trees below are one day of real data hard-linked into 30 dated
directories, with no hot store. The rows therefore repeat, and a 30-day range
returns 30× the rows — so these numbers overstate the row cost of a real
30-day window and measure the file cost honestly.

| tree                   | files | one path, 30 days           | paths, 30 days      | one path, one day |
| ---------------------- | ----- | --------------------------- | ------------------- | ----------------- |
| roll files (8 per day) | 240   | 2,195–2,244 (e 1,836–1,892) | 661–727 (e 381–438) | 360–435           |
| compacted (1 per day)  | 30    | 1,916–2,062 (e 1,579–1,746) | 601–631 (e 339–367) | 375–444           |

**Per-file planning cost is about 1 ms.** Collapsing 240 files into 30 saves
~230 ms of a 2,200 ms query and ~60 ms of a 660 ms one. The 30-day query is
dominated by its 82,590 rows, not by its files, so the condition Unit 3a set
for reopening compaction is not met. Compacting one day cost 639 ms in a
process Unit 3a measured at 344–484 MB — the largest transient in the design —
to save 230 ms on a query nobody has to make.

**A date-scoped query does not care how large the tree is.** 1 file, 8 files
and 240 files all answer a one-day single-path range in 360–444 ms. That is
the property the layout was chosen for, and it is the reason a long-range query
stays avoidable rather than fast.

So the decision stands: no compaction pass, no path partitioning. What would
reopen it is a _real_ thirty-day tree — 720 files at hourly rolls — where the
same per-file slope predicts ~720 ms of planning. That is worth re-measuring
once a device has one, and it is not worth pre-emptively engineering for.

`getPaths` is a scan rather than a directory listing, and the flat layout is
why. It costs 448–486 ms over a day and 601–727 ms over thirty. The cumulative
sidecar could answer "every path ever" from one 11 kB file, but not "every path
with data in this range", which is what the history API asks. Nothing in Unit
4a reads the sidecar.

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

Two query processes may run at once; a third waits, and past eight waiting the
answer is a refusal rather than a queue. The deadline for one request is 30
seconds and covers the wait as well as the work, so a request that spent it all
queued is failed rather than spawned into a socket nobody is reading.

**Nothing coordinates a query with a roll.** The roll runs on the writer's
schedule and a query arrives when a client asks, so the worst case is the sum
of separately measured peaks:

| at once                        | MB   |
| ------------------------------ | ---- |
| two queries at 220 MB          | 440  |
| a roll (Unit 3b, on this data) | 163  |
| **summed transient**           | ~600 |

That is a sum of peaks measured apart, not a measured combination. It fits a
4 GB device running the marine stack, which is why nothing admission-controls
the two against each other. A device where it does not fit wants a lower query
cap before it wants a scheduler.

The 220 MB is an answer of ~82,000 rows; a single-path range is 118–127 MB. A
query returns at most 100,000 rows and says so when it truncated, because the
Signal K process holds the whole answer to serialise it — the row limit is a
ceiling on _that_ process, not on this one.

## What this does not measure

- **Aggregation.** Unit 4a returns raw rows. Bucketed aggregates are the v2
  surface's, and nothing here prices them.
- **A concurrent roll and query.** The summed transient above is arithmetic.
- **A tree with a real retention window in it.** Both aged trees are one day of
  data wearing thirty dates.
- **A file deleted while a query reads it.** The file list is taken before the
  statement runs, so expiry (Unit 5a) has to decide what a reader that is
  already holding a list should see.
