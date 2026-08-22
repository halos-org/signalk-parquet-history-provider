import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CONFIG_DEFAULTS,
  Config,
  ConfigSchema,
  normalizeConfig,
} from "../config/schema.js";

// A configuration that came out of the Admin UI form, with every key present.
const complete: Config = {
  pathFilter: { mode: "include", paths: ["navigation.*"] },
  defaultSamplingRate: 500,
  samplingRates: { "environment.wind.*": 200 },
  recordSelf: true,
  recordOthers: true,
  maxRecordedPaths: 50,
  maxRecordedContexts: 5,
  dataDir: "/var/lib/history",
  retentionDays: 30,
  rollIntervalMinutes: 15,
};

describe("ConfigSchema", () => {
  it("renders every option the plugin is configured with", () => {
    // The Admin UI form IS this schema, so a missing property is a missing
    // form field the operator can never set.
    const properties = Object.keys(ConfigSchema.properties);
    assert.deepEqual(properties.sort(), [
      "dataDir",
      "defaultSamplingRate",
      "maxRecordedContexts",
      "maxRecordedPaths",
      "pathFilter",
      "recordOthers",
      "recordSelf",
      "retentionDays",
      "rollIntervalMinutes",
      "samplingRates",
    ]);
  });

  it("carries a default for every option", () => {
    for (const [name, property] of Object.entries(ConfigSchema.properties)) {
      if (name === "pathFilter") {
        for (const [sub, subProperty] of Object.entries(
          (property as any).properties,
        )) {
          assert.notEqual(
            (subProperty as any).default,
            undefined,
            `pathFilter.${sub} has no default`,
          );
        }
        continue;
      }
      assert.notEqual(
        (property as any).default,
        undefined,
        `${name} has no default`,
      );
    }
  });

  it("defaults other vessels off", () => {
    // Every AIS target is a context, and the roll holds a Parquet writer per
    // partition — so this default is what bounds the roll's memory peak on a
    // busy waterway, not a preference.
    assert.equal((ConfigSchema.properties.recordOthers as any).default, false);
    assert.equal((ConfigSchema.properties.recordSelf as any).default, true);
  });
});

describe("normalizeConfig", () => {
  it("leaves a complete configuration alone", () => {
    assert.deepEqual(normalizeConfig(complete), complete);
  });

  it("fills in a configuration saved before an option existed", () => {
    const saved = {
      pathFilter: { mode: "exclude", paths: [] },
      defaultSamplingRate: 2000,
      samplingRates: {},
      recordSelf: true,
      recordOthers: false,
    } as unknown as Config;
    const normalized = normalizeConfig(saved);
    assert.equal(normalized.retentionDays, CONFIG_DEFAULTS.retentionDays);
    assert.equal(
      normalized.rollIntervalMinutes,
      CONFIG_DEFAULTS.rollIntervalMinutes,
    );
    assert.equal(normalized.maxRecordedPaths, CONFIG_DEFAULTS.maxRecordedPaths);
    assert.equal(
      normalized.maxRecordedContexts,
      CONFIG_DEFAULTS.maxRecordedContexts,
    );
    assert.equal(normalized.dataDir, "");
  });

  it("fills in a wholly empty configuration", () => {
    const normalized = normalizeConfig({} as Config);
    assert.deepEqual(normalized.pathFilter, { mode: "exclude", paths: [] });
    assert.deepEqual(normalized.samplingRates, {});
    assert.equal(normalized.recordSelf, true);
    assert.equal(normalized.recordOthers, false);
    assert.equal(
      normalized.defaultSamplingRate,
      CONFIG_DEFAULTS.defaultSamplingRate,
    );
  });

  it("honours an explicit false on the context toggles", () => {
    const normalized = normalizeConfig({
      ...complete,
      recordSelf: false,
      recordOthers: false,
    });
    assert.equal(normalized.recordSelf, false);
    assert.equal(normalized.recordOthers, false);
  });

  it("keeps zero where zero means something", () => {
    // 0 is "record every update" and "keep forever", not "unset".
    const normalized = normalizeConfig({
      ...complete,
      defaultSamplingRate: 0,
      retentionDays: 0,
    });
    assert.equal(normalized.defaultSamplingRate, 0);
    assert.equal(normalized.retentionDays, 0);
  });

  it("rejects values that would mean roll continuously or record nothing", () => {
    // A hand-edited zero here is not a setting the plugin can honour, and the
    // failure would be a roll process spawning without pause.
    const normalized = normalizeConfig({
      ...complete,
      rollIntervalMinutes: 0,
      maxRecordedPaths: 0,
      maxRecordedContexts: -1,
    });
    assert.equal(
      normalized.rollIntervalMinutes,
      CONFIG_DEFAULTS.rollIntervalMinutes,
    );
    assert.equal(normalized.maxRecordedPaths, CONFIG_DEFAULTS.maxRecordedPaths);
    assert.equal(
      normalized.maxRecordedContexts,
      CONFIG_DEFAULTS.maxRecordedContexts,
    );
  });

  it("rejects a non-finite number rather than propagating it", () => {
    const normalized = normalizeConfig({
      ...complete,
      defaultSamplingRate: Number.NaN,
      retentionDays: Number.POSITIVE_INFINITY,
    });
    assert.equal(
      normalized.defaultSamplingRate,
      CONFIG_DEFAULTS.defaultSamplingRate,
    );
    assert.equal(normalized.retentionDays, CONFIG_DEFAULTS.retentionDays);
  });
});
