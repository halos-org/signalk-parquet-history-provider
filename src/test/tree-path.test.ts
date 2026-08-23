import { describe, it } from "node:test";
import assert from "node:assert";
import { join, resolve, sep } from "node:path";
import {
  assertUnderDataDir,
  dateDirectory,
  rollFile,
  rollTempFile,
  sidecarFile,
  utcDateSegment,
} from "../roll/tree-path.js";

const DATA = "/var/lib/parquet-history";

describe("utcDateSegment", () => {
  it("names the UTC date, not the local one", () => {
    // 2026-08-23T23:30:00Z is already the 24th in +03:00, which is where this
    // is developed and where the device runs. A local date here would put a
    // row in the wrong directory for half the vessels on earth.
    assert.equal(utcDateSegment(Date.UTC(2026, 7, 23, 23, 30)), "2026-08-23");
    assert.equal(utcDateSegment(Date.UTC(2026, 7, 24, 0, 30)), "2026-08-24");
  });

  it("pads month and day", () => {
    assert.equal(utcDateSegment(Date.UTC(2026, 0, 5)), "2026-01-05");
  });

  it("refuses a timestamp it cannot name", () => {
    // Date's toISOString throws on these, but only after the value has been
    // through arithmetic that turns them into "Invalid Date" — and a directory
    // called NaN-NaN-NaN is a thing a roll would happily create.
    for (const ts of [NaN, Infinity, -Infinity, 1e18]) {
      assert.throws(() => utcDateSegment(ts), /timestamp/, `${ts}`);
    }
  });
});

describe("paths inside the tree", () => {
  it("puts a roll's file under its date", () => {
    const ts = Date.UTC(2026, 7, 23, 14, 5);
    assert.equal(
      rollFile(DATA, ts, 1_787_500_000_000),
      join(DATA, "parquet", "date=2026-08-23", "1787500000000.parquet"),
    );
  });

  it("names a directory a roll can create before writing into it", () => {
    const ts = Date.UTC(2026, 7, 23, 14, 5);
    assert.equal(
      dateDirectory(DATA, ts),
      join(DATA, "parquet", "date=2026-08-23"),
    );
  });

  it("keeps the partial file out of a *.parquet glob", () => {
    const temp = rollTempFile(DATA, Date.UTC(2026, 7, 23), 1);
    // This is the whole mechanism that stops a killed roll leaving something
    // a reader treats as complete: the suffix, not a lock or a marker.
    assert.ok(temp.endsWith(".tmp"), temp);
    assert.ok(!temp.endsWith(".parquet"), temp);
  });

  it("keeps the sidecar out of the tree", () => {
    const sidecar = sidecarFile(DATA);
    // A reader globbing the tree must not find it. Its rows are copies of
    // rows already in the tree, so a glob that reached it would double-count
    // every path's last value.
    assert.ok(!sidecar.startsWith(join(DATA, "parquet") + sep), sidecar);
    assert.equal(sidecar, join(DATA, "latest", "latest.parquet"));
  });

  it("resolves a relative data directory rather than trusting the cwd", () => {
    const path = rollFile("relative/dir", Date.UTC(2026, 7, 23), 1);
    assert.ok(path.startsWith(resolve("relative/dir")), path);
  });
});

describe("containment", () => {
  it("refuses a roll id that is not a number", () => {
    // Nothing delta-supplied reaches these arguments — the roll id is the
    // writer's own clock reading. Both guards are here for the change that
    // reintroduces an untrusted segment.
    assert.throws(
      () => rollFile(DATA, Date.UTC(2026, 7, 23), "../../etc/passwd" as never),
      /roll id/,
    );
  });

  it("refuses a path that climbs out of the data directory", () => {
    assert.throws(
      () =>
        assertUnderDataDir(DATA, join(DATA, "..", "elsewhere", "x.parquet")),
      /data directory/,
    );
    assert.throws(
      () => assertUnderDataDir(DATA, "/etc/passwd"),
      /data directory/,
    );
    // The data directory itself is not a file inside it.
    assert.throws(() => assertUnderDataDir(DATA, DATA), /data directory/);
  });

  it("accepts a path inside and returns it resolved", () => {
    assert.equal(
      assertUnderDataDir(
        DATA,
        join(DATA, "parquet", "date=2026-08-23", "1.parquet"),
      ),
      join(DATA, "parquet", "date=2026-08-23", "1.parquet"),
    );
  });
});
