import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DATA_LAYOUT, resolveDataDir } from "../data-dir.js";

describe("resolveDataDir", () => {
  const pluginDir = "/home/pi/.signalk/plugin-config-data/parquet";

  it("uses the Signal K plugin directory when nothing is configured", () => {
    assert.equal(resolveDataDir("", pluginDir), pluginDir);
    assert.equal(resolveDataDir("   ", pluginDir), pluginDir);
  });

  it("takes an absolute setting as given", () => {
    assert.equal(
      resolveDataDir("/mnt/data/history", pluginDir),
      "/mnt/data/history",
    );
  });

  it("resolves a relative setting against the plugin directory, not the cwd", () => {
    // The writer, the roll and every query run in separate processes that do
    // not share the server's working directory, so a cwd-relative answer
    // would put them in different places.
    assert.equal(resolveDataDir("history", pluginDir), `${pluginDir}/history`);
    assert.equal(
      resolveDataDir("../shared-history", pluginDir),
      "/home/pi/.signalk/plugin-config-data/shared-history",
    );
  });

  it("normalises a path with redundant segments", () => {
    assert.equal(
      resolveDataDir("/mnt/./data//history/", pluginDir),
      "/mnt/data/history",
    );
  });
});

describe("DATA_LAYOUT", () => {
  it("names each sub-directory once", () => {
    const names = Object.values(DATA_LAYOUT);
    assert.equal(new Set(names).size, names.length);
  });
});
