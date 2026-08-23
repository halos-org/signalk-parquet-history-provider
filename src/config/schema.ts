import { Type, Static } from "typebox";

/**
 * The single source of truth for both the JSON schema the Signal K Admin UI
 * renders and the `Config` TypeScript type. Add options here, never in two
 * places.
 */
export const ConfigSchema = Type.Object({
  pathFilter: Type.Object({
    mode: Type.Union([Type.Literal("exclude"), Type.Literal("include")], {
      default: "exclude",
      title: "Filter mode",
    }),
    paths: Type.Array(Type.String(), {
      default: [],
      title: "Path patterns (glob supported)",
      description: 'e.g. "notifications.*", "environment.wind.*"',
    }),
  }),

  defaultSamplingRate: Type.Number({
    default: 2000,
    title: "Default sampling rate (ms)",
    description:
      "Minimum ms between recorded samples for any path (0 = record every update). Lower it for individual paths with the per-path overrides below.",
  }),

  samplingRates: Type.Record(Type.String(), Type.Number(), {
    default: {},
    title: "Per-path sampling rates (ms)",
    description:
      'Override the default rate for specific paths. e.g. { "environment.wind.*": 200, "tanks.*": 10000 }',
  }),

  recordSelf: Type.Boolean({
    default: true,
    title: "Record own vessel",
  }),
  recordOthers: Type.Boolean({
    default: false,
    title: "Record other vessels",
    description:
      "Off by default. AIS targets add a context per vessel, and the roll holds one Parquet writer per partition — so this setting, more than data volume, is what sets the roll's memory peak.",
  }),

  maxRecordedPaths: Type.Number({
    default: 2000,
    title: "Maximum distinct recorded paths",
    description:
      "Paths beyond this many are ignored, and the count is reported in the plugin status. A misbehaving source emitting unbounded paths would otherwise inflate the partition count without limit.",
  }),
  maxRecordedContexts: Type.Number({
    default: 100,
    title: "Maximum distinct recorded contexts",
    description:
      "The same bound for vessel contexts. Only relevant when other vessels are recorded.",
  }),

  dataDir: Type.String({
    default: "",
    title: "Data directory",
    description:
      "Where the hot store and the Parquet tree live. Empty means the plugin's own directory under the Signal K data directory.",
  }),

  retentionDays: Type.Number({
    default: 0,
    title: "Retention (days, 0 = keep forever)",
  }),

  rollIntervalMinutes: Type.Number({
    default: 60,
    title: "Roll interval (minutes)",
    description:
      "How often the hot store is rolled into the Parquet tree and truncated. Shorter keeps the hot store small and costs more Parquet files; longer does the reverse.",
  }),
});

export type Config = Static<typeof ConfigSchema>;

/** Every default in one place, so normalization and the schema cannot drift. */
export const CONFIG_DEFAULTS = {
  pathFilterMode: "exclude" as const,
  pathFilterPaths: [] as string[],
  defaultSamplingRate: 2000,
  samplingRates: {} as Record<string, number>,
  recordSelf: true,
  recordOthers: false,
  maxRecordedPaths: 2000,
  maxRecordedContexts: 100,
  dataDir: "",
  retentionDays: 0,
  rollIntervalMinutes: 60,
};

/**
 * What Signal K actually hands `start()`: whatever JSON is on disk, which may
 * predate any given option or have been edited by hand. Typing it as `Config`
 * would let a later unit accept a raw stored config and dereference a key that
 * is not there — the failure that silently stopped recording in the sibling
 * provider.
 */
export type StoredConfig = {
  [K in keyof Config]?: K extends "pathFilter"
    ? Partial<Config["pathFilter"]>
    : Config[K];
};

/**
 * Fill in config keys that a saved configuration may lack. Signal K hands the
 * plugin its stored configuration verbatim — TypeBox defaults are applied by
 * the Admin UI form only, so a config saved before an option existed (or
 * hand-edited) simply misses the key, and the per-delta path would dereference
 * it on every delta. Normalize once at the boundary instead of guarding every
 * consumer.
 *
 * Numeric fields are also range-checked here rather than trusted: a
 * hand-edited zero or negative roll interval would otherwise mean "roll
 * continuously".
 */
export function normalizeConfig(config: StoredConfig): Config {
  return {
    ...config,
    pathFilter: {
      mode:
        config.pathFilter?.mode === "include" ||
        config.pathFilter?.mode === "exclude"
          ? config.pathFilter.mode
          : CONFIG_DEFAULTS.pathFilterMode,
      // Shape-checked, not just null-coalesced. A hand-edited `"paths":
      // "navigation.*"` is a string, and PathMatcher iterates a string
      // character by character -- the `*` compiles to a glob matching every
      // path, which in exclude mode records nothing at all.
      paths: stringArray(config.pathFilter?.paths),
    },
    samplingRates: numberRecord(config.samplingRates),
    defaultSamplingRate: nonNegative(
      config.defaultSamplingRate,
      CONFIG_DEFAULTS.defaultSamplingRate,
    ),
    // A missing toggle takes the schema default; an explicit false is honoured.
    recordSelf: config.recordSelf ?? CONFIG_DEFAULTS.recordSelf,
    recordOthers: config.recordOthers ?? CONFIG_DEFAULTS.recordOthers,
    maxRecordedPaths: positive(
      config.maxRecordedPaths,
      CONFIG_DEFAULTS.maxRecordedPaths,
    ),
    maxRecordedContexts: positive(
      config.maxRecordedContexts,
      CONFIG_DEFAULTS.maxRecordedContexts,
    ),
    dataDir:
      typeof config.dataDir === "string"
        ? config.dataDir
        : CONFIG_DEFAULTS.dataDir,
    retentionDays: nonNegative(
      config.retentionDays,
      CONFIG_DEFAULTS.retentionDays,
    ),
    rollIntervalMinutes: positive(
      config.rollIntervalMinutes,
      CONFIG_DEFAULTS.rollIntervalMinutes,
    ),
  };
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [...CONFIG_DEFAULTS.pathFilterPaths];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function numberRecord(value: unknown): Record<string, number> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ...CONFIG_DEFAULTS.samplingRates };
  }
  // Non-positive overrides are dropped rather than carried through. The field
  // is a minimum interval between samples, so 0 and negatives are not values
  // it can honour; dropping them falls back to the default rate, which is what
  // the rate matcher does with them anyway.
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, number] =>
        typeof entry[1] === "number" &&
        Number.isFinite(entry[1]) &&
        entry[1] > 0,
    ),
  );
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

// Distinct from `positive` because 0 is meaningful for these two: it means
// "no sampling cap" and "keep forever" respectively.
function nonNegative(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : fallback;
}
