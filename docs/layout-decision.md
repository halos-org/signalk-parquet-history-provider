# Tree layout decision

What the roll writes, how often, whether a compaction pass follows it, and
whether it emits a last-value sidecar. Unit 3a of
[halos-org/halos#152](https://github.com/halos-org/halos/issues/152), settled by
measurement on the device rather than by argument, because the file count that
falls out of these choices is what a later query has to live with and reversing
one after data exists means re-rolling the tree.

## The decision

1. **No path partitioning.** One Parquet file per roll, holding every context
   and every path, with `context` and `path` as columns. The directory tree
   carries time only: `<data-dir>/parquet/date=<YYYY-MM-DD>/<rollStart>.parquet`.
2. **Hourly rolls**, aligned to the UTC hour.
3. **No compaction pass.** The roll's output is the final form of the file.
4. **A cumulative last-value sidecar per roll**, one row per
   `(context, path)`.

## What was measured

A snapshot of the live hot store on a HALPI2 (4 GB, aarch64, DuckDB 1.5.5,
Node 22.23.2), taken with `VACUUM INTO` while the writer kept ingesting:

|                            |                                          |
| -------------------------- | ---------------------------------------- |
| rows                       | 1,267,241                                |
| span                       | 2 h 48 min                               |
| rate                       | 125.7 rows/second                        |
| distinct `(context, path)` | 552                                      |
| distinct paths             | 525                                      |
| contexts                   | 29, of which `self` holds 1,267,206 rows |
| store on disk              | 129.7 MiB                                |

Half of everything recorded is notifications: `notifications.*` is 144 paths and
621,945 rows. `vhfdata.*` is another 96 paths and 175,875 rows. The 28 non-self
contexts hold one or two rows each — AIS identity records — so any layout that
made `context` a directory would create 28 near-empty directories per roll. That
distribution is a recording-policy question for another unit; here it is the
input.

Every roll and every query ran in its own process at `memory_limit = 256MB`, and
each cell ran three times. Peaks are `VmHWM` from `/proc/self/status`, write
volume is `write_bytes` from `/proc/self/io`, CPU is `process.cpuUsage`, read
the same way `src/bench/proc.ts` parses them — the scratch scripts duplicated
that parsing rather than importing the harness, which is the one place these
numbers depart from the project's measurement rule. Figures are median with
range.

**Every peak below includes the process itself.** Node alone is 75–87 MB
resident; opening DuckDB takes it to 85–96 MB; loading `sqlite_scanner`,
attaching the hot store and counting it reaches 97–99 MB. Subtract that to get
what a roll costs beyond existing.

## Why no path partitioning

Three layouts were rolled from the same window: no partitioning at all,
`(context, top-level path group)` — 38 partitions — and `(context, path)` — 552
partitions.

| layout | rows      | peak RSS                  | wall     | output  | files |
| ------ | --------- | ------------------------- | -------- | ------- | ----- |
| flat   | 38,970    | 109.3 MB (109.1–109.5)    | 1,057 ms | 0.11 MB | 1     |
| flat   | 381,494   | 141.6 MB (140.2–146.1)    | 1,266 ms | 0.97 MB | 1     |
| flat   | 1,267,240 | 146.5 MB (142.8–150.7)    | 1,720 ms | 3.18 MB | 1     |
| group  | 1,267,240 | 470.4 MB (447–491.7)      | 1,783 ms | 2.64 MB | 38    |
| path   | 38,970    | 223.2 MB (222.6–224.2)    | 655 ms   | 0.74 MB | 546   |
| path   | 381,494   | **out of memory, 3 of 3** |          |         |       |
| path   | 1,267,240 | **out of memory, 3 of 3** |          |         |       |

A partitioned write's peak follows the row count and a plain `COPY`'s does not.
Rolling 38,970, 381,494 and 1,267,240 rows costs the group layout 130.9, 280.6
and 470.4 MB, and the flat layout 109.3, 141.6 and 146.5 MB. The shape of that —
memory proportional to input, released only at the end — is what a write that
collects its result set before emitting it looks like, though this measured the
behaviour and not the engine's source. At 552 partitions it exceeds a 256 MB
limit on anything longer than a ten-minute window, and none of the knobs that
look like they should contain it do: `row_group_size` at 2,048, 10,000, 40,000
and 122,880 all fail, `partitioned_write_max_open_files` at 8, 32 and 100 all
fail, and `preserve_insertion_order = false` fails. Only `threads = 1` succeeds,
at 307.7–308.8 MB and 5,208–5,470 ms against the flat roll's 1,720 ms.

The partitioned write is also loud on disk. Writing 2.64 MB of Parquet through
`PARTITION_BY` puts 32.5–45.1 MB through the block layer; the flat `COPY` writes
3.2 MB for 3.18 MB of output.

Then the tree itself. The same 1,267,240 rows, cut the six ways that were built:

| tree                     | files  | Parquet bytes | disk      |
| ------------------------ | ------ | ------------- | --------- |
| one sorted file per day  | 1      | 2.40 MiB      | 2.5 MB    |
| one file per day         | 1      | 3.18 MiB      | 3.2 MB    |
| one file per roll        | 24     | 3.51 MiB      | 3.6 MB    |
| group, one file per day  | 38     | 2.61 MiB      | 3.0 MB    |
| group, one file per roll | 272    | 3.24 MiB      | 4.0 MB    |
| path, one file per day   | 552    | 4.06 MiB      | 7.5 MB    |
| path, one file per roll  | 10,337 | **21.4 MiB**  | **43 MB** |

Per-path files at a per-roll cadence hold six times the Parquet bytes of the
flat tree for identical data and occupy twelve times the disk, because a file
averaging 2.2 kB is mostly header and footer and still takes a 4 kB block.

And they are slower to read, not faster. Against the one-day trees, times are
total wall clock from process start, which is how a spawned query is actually
paid for:

| tree                           | files  | single-path range      | latest value, all paths | peak RSS   |
| ------------------------------ | ------ | ---------------------- | ----------------------- | ---------- |
| flat, per roll                 | 24     | 150 ms (133–182)       | 247 ms (226–248)        | 105–106 MB |
| group, per roll                | 272    | 144 ms (127–145)       | 232 ms (219–244)        | 107–118 MB |
| path, per roll                 | 10,337 | 1,298 ms (1,292–1,474) | 2,059 ms (2,055–2,241)  | 389–512 MB |
| flat, one file                 | 1      | 140 ms (113–144)       | 212 ms (201–227)        | 108 MB     |
| flat, one file, sorted by path | 1      | 104 ms (100–114)       | 157 ms (144–175)        | 98–107 MB  |
| group, per day                 | 38     | 105 ms (104–135)       | 200 ms (186–230)        | 101–111 MB |
| path, per day                  | 552    | 189 ms (176–237)       | 277 ms (270–421)        | 112–123 MB |

**Process startup is 70–110 ms of every one of those totals.** Spawning Node,
opening DuckDB and loading the extension costs more than any well-shaped query
over a day of data. The gap between the best layout here and the flat one is
about 40 ms, against a floor nothing in this design can go below, which is why
40 ms does not buy a partitioning scheme.

There is one more thing the flat layout gets for free. The plan's risk table
carries "delta-supplied path and context strings become directory names",
mitigated by an allowlist and a containment assertion. With only the date as a
directory, and the date generated rather than received, no untrusted string ever
reaches the filesystem. The risk is closed by construction rather than guarded.

### The case against, with its numbers

Partitioning does buy something: the planner skips files without opening them.
It shows up only on a long-range single-path query over an aged tree. Each tree
was aged to 30 days by hard-linking one day's output into 30 dated copies, which
measures planning and metadata cost honestly and understates I/O — 30 links to
one inode share a page-cache entry where 30 real days would not.

| tree                      | files  | whole range                          | one day          |
| ------------------------- | ------ | ------------------------------------ | ---------------- |
| flat, per roll            | 720    | 965 ms (931–1,169), 75.5 MB read     | 117 ms (116–152) |
| group, per roll           | 8,160  | 1,599 ms (1,597–1,604), 28 MB read   | 144 ms (124–154) |
| flat, one per day, sorted | 30     | 327 ms (303–352), 7 MB read          | 103 ms (101–111) |
| group, one per day        | 1,140  | 559 ms (544–574), 19.1 MB read       | 112 ms (100–150) |
| path, one per day         | 16,560 | 3,068 ms (2,864–3,282), 17.1 MB read | 174 ms (170–179) |

So group partitioning is about twice as fast as flat for a single path over
thirty days — but only when it is also compacted to one file per partition per
day. At a per-roll cadence it is slower than flat (1,599 ms against 965 ms),
because eight thousand files cost more to plan than seven hundred. Partitioning
pays only in combination with a compaction pass, and that pass is priced below.

The one-day column is the same query with the date directory pruning it, and
every layout lands within 100–180 ms there. A date directory is what makes
long-range queries avoidable; path partitioning is what makes them slightly
cheaper when they are not.

## Why hourly

The interval sets three things, and they do not pull in the same direction.

**The hot store's size, and with it the cost of every recent query.** The
snapshot averages 46 MiB of SQLite per hour at 125.7 rows/second; its last
hour is 50 MB and 492,734 rows. The roll truncates the store, so the interval is
the ceiling. Every query that touches recent time reads the unrolled remainder
through `sqlite_scanner`, and that read is a full table scan:

| hot store | rows      | single-path range | latest value, all paths |
| --------- | --------- | ----------------- | ----------------------- |
| 13 MB     | 122,672   | 63 ms (60–64)     | 94 ms (94–100)          |
| 50 MB     | 492,734   | 102 ms (99–117)   | 161 ms (142–175)        |
| 130 MB    | 1,267,241 | 248 ms (236–267)  | 441 ms (350–507)        |

An index on `ts` does not change it — 67, 110 and 246 ms for the same three
stores — so the scan is not avoidable by indexing and the interval is the only
control there is. The three points are close to linear at about 1.9 ms per MB,
which puts an hourly store's recent-query floor near 100 ms and a four-hourly
one's near 250 ms. A daily store would be around 1.2 GB; extrapolating the same
slope gives a two-second scan, which was not measured.

**Roll cost.** An hour here is 381,494 rows at the start of the span and
492,734 at the end; the flat roll writes the first of those in 1,266 ms
(1,220–1,299) at 141.6 MB (140.2–146.1). The roll is indifferent to how much
larger it gets: streaming the snapshot two, four and nine times over, up to
11.4M rows — a day at the observed rate — peaks at 152–194 MB, 232–247 MB and
204–246 MB respectively, while wall time rises linearly to 15.5–15.9 s. Memory
does not decide the interval.

**File count.** 24 files a day, 720 in a thirty-day window, 8,760 in a year. The
aged-tree table above says 720 files answer a whole-range single-path query in
931–1,169 ms and a date-scoped one in 116–152 ms.

Fifteen-minute rolls would cut the recent-query floor from ~100 ms to ~63 ms and
raise the file count fourfold, to 2,880 in a thirty-day window. That is a
defensible other answer. Hourly is chosen because 24 files a day is already past
the point where file count is doing any harm, and the remaining 40 ms is inside
the startup cost of the process asking for it.

Two constraints come with it. The interval must divide 24 hours and align to UTC
midnight, so that no roll straddles a date directory. And the sample rate that
produced these figures — 125.7 rows/second, 552 paths — is one vessel's; the
hot-store column scales with it, and an installation recording ten times as much
should read the 130 MB row rather than the 50 MB one.

## Compaction: no

Compaction would merge a day of roll files into one file per partition. Its only
real gain is that a merged file can be sorted by path, which gives row-group
statistics something to prune on:

|                               | single-path range | bytes read | tree     |
| ----------------------------- | ----------------- | ---------- | -------- |
| 24 flat roll files            | 150 ms (133–182)  | 2.5 MB     | 3.51 MiB |
| one flat file, sorted by path | 104 ms (100–114)  | 0.2 MB     | 2.40 MiB |

Roughly 40 ms and 1.1 MiB a day. The cost is a second short-lived process at
466.5–484.6 MB peak that spills 46–51.2 MB to disk sorting 1.27M rows — the
largest transient anywhere in this design, larger than the roll it would follow,
and it arrives with its own scheduling, its own atomicity and its own failure
mode. A day at the real rate is 11M rows, not 1.27M, so that peak is a floor.

Compaction without the sort is cheaper — 344.4–369.4 MB, 704 ms — and buys
almost nothing: 140 ms against 150 ms, 3.18 MiB against 3.51 MiB.

So: no compaction pass, and no second unit for one.

**What would reopen it.** If Unit 4a's real reader shows a multi-day query
dominated by per-file cost rather than by startup. The aged-tree row for 720
flat files — 931–1,169 ms and 75.5 MB read for one path over thirty days — is
the warning sign to watch. If that shape turns out to be common, the answer is
group partitioning plus daily compaction (559 ms, 19.1 MB), and it has to be
decided before a year of tree exists.

## The sidecar: yes

Each roll writes one extra file holding the last value of every
`(context, path)` seen so far — cumulative, folding the previous sidecar into
the current window. Cumulative is not a refinement: a sidecar holding only its
own roll's paths answers "latest value" wrong for any path that stopped
reporting before the newest roll, which is the case the query exists to serve.

Measured over 24 rolls, three times: 26–28 ms median per roll (15–71 ms across
individual rolls), 11,185 bytes, 552 rows. Answering the all-paths snapshot from
the newest sidecar takes 92–96 ms total, of which 14–18 ms is the query. The
same answer costs 226–248 ms from a one-day tree of roll files, and
2,779–2,841 ms from a thirty-day one. That last number is the one that decides
it: a snapshot query's cost against a tree grows with the retention window and
the sidecar's does not.

It bounds the tree half of that query only. The hot-store half is still a full
scan — 94 ms at 13 MB, 441 ms at 130 MB — which is the roll interval again.

## Provisional

**Query latency is provisional in one direction and settled in the other.** The
reader that will actually run these queries is Unit 4a; every statement measured
here was written for the measurement. The _ordering_ between layouts is robust —
a 43 MB tree of 10,337 files is not going to overtake a 3.6 MB tree of 24
through better SQL — and that ordering is what the decision rests on. The
absolute numbers are not a prediction of what Unit 4a will report, and Unit 4a
re-measures them against the real reader.

Two other limits worth stating. The aged trees hold thirty days of _files_ and
one day of _bytes_, so their timestamps repeat and no time pruning is possible
within them; the whole-range rows are therefore honest for a query that really
does span the window and pessimistic for one that does not, which is what the
one-day column brackets. And nothing here measured aggregation, so Unit 5b's
resolution ladder — which runs inside a roll process whose peak this document
reports — is unpriced.

## What this changes in later units

- **Unit 3b** loses `src/roll/partitioning.ts` and most of
  `src/roll/path-guard.ts`. No delta-supplied string becomes a directory name,
  so the guard shrinks to the date segment the roll generates itself. Its
  "a roll spanning a partition boundary" test becomes a UTC date boundary, and
  "paths producing no rows create no empty partitions" no longer applies.
- **Unit 3b** writes the sidecar, and reads the previous one to do it.
- **Unit 4a** reads a tree of dated directories holding one file per roll, and
  its file selection is a date-directory glob plus a timestamp filter — not hive
  partition pruning on `path`.
- **Unit 5a** expires whole files by their roll window, and can drop a whole
  date directory when the retention boundary falls on one. Whether retention is
  a storage bound or a deletion guarantee is still that unit's to state: a roll
  file holds an hour, so the boundary is an hour wide.
