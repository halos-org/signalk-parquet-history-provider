import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Temporal } from "@js-temporal/polyfill";
import { resolveTimeRange } from "../time-range.js";

describe("resolveTimeRange", () => {
  it("resolves from + to", () => {
    const from = Temporal.Instant.from("2024-01-01T00:00:00Z");
    const to = Temporal.Instant.from("2024-01-02T00:00:00Z");
    const result = resolveTimeRange({ from, to });
    assert.ok(result.from.includes("2024-01-01"));
    assert.ok(result.to.includes("2024-01-02"));
  });

  it("resolves from + duration", () => {
    const from = Temporal.Instant.from("2024-01-01T00:00:00Z");
    const duration = Temporal.Duration.from({ hours: 1 });
    const result = resolveTimeRange({ from, duration });
    assert.ok(result.from.includes("2024-01-01"));
    assert.ok(result.to.includes("2024-01-01T01:00:00"));
  });

  it("resolves to + duration", () => {
    const to = Temporal.Instant.from("2024-01-02T00:00:00Z");
    const duration = Temporal.Duration.from({ hours: 1 });
    const result = resolveTimeRange({ to, duration });
    assert.ok(result.from.includes("2024-01-01T23:00:00"));
    assert.ok(result.to.includes("2024-01-02"));
  });

  it("resolves from only (to defaults to now)", () => {
    const from = Temporal.Instant.from("2024-01-01T00:00:00Z");
    const result = resolveTimeRange({ from });
    assert.ok(result.from.includes("2024-01-01"));
    // to should be close to now
    const toDate = new Date(result.to);
    assert.ok(Date.now() - toDate.getTime() < 5000);
  });

  it("resolves duration only (from = now - duration)", () => {
    const duration = Temporal.Duration.from({ minutes: 30 });
    const result = resolveTimeRange({ duration });
    const from = new Date(result.from);
    const to = new Date(result.to);
    const diffMs = to.getTime() - from.getTime();
    // Should be approximately 30 minutes
    assert.ok(
      Math.abs(diffMs - 30 * 60 * 1000) < 5000,
      `Expected ~30min diff, got ${diffMs}ms`,
    );
  });

  it("resolves numeric duration (seconds)", () => {
    const from = Temporal.Instant.from("2024-01-01T00:00:00Z");
    const result = resolveTimeRange({ from, duration: 3600 });
    assert.ok(result.to.includes("2024-01-01T01:00:00"));
  });

  it("treats a zero duration as a value, not as absent", () => {
    // Under a truthiness test every duration branch is skipped: this returned
    // `from` until now — an unbounded range where an empty one was asked for.
    const from = Temporal.Instant.from("2024-01-01T00:00:00Z");
    const result = resolveTimeRange({ from, duration: 0 });
    assert.equal(result.from, result.to);
    assert.ok(result.to.includes("2024-01-01T00:00:00"));
  });

  it("resolves to + a zero duration instead of throwing", () => {
    const to = Temporal.Instant.from("2024-01-02T00:00:00Z");
    const result = resolveTimeRange({ to, duration: 0 });
    assert.equal(result.from, result.to);
  });

  it("resolves a zero Temporal.Duration the same way", () => {
    const from = Temporal.Instant.from("2024-01-01T00:00:00Z");
    const zero = Temporal.Duration.from({ seconds: 0 });
    const result = resolveTimeRange({ from, duration: zero });
    assert.equal(result.from, result.to);
  });

  it("throws on empty params", () => {
    assert.throws(() => resolveTimeRange({}));
  });
});
