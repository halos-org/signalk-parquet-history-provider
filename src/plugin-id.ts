/**
 * The plugin's identity, in ONE place.
 *
 * Signal K derives almost nothing from the package name: `plugin.id` is
 * declared in code, and the id then reappears as the sender argument to
 * `app.handleMessage`, in the plugin's config filename, and as the name a
 * history provider registers under. A mismatch at any of those sites fails at
 * runtime, not at build time, so every site reads it from here.
 */
export const PLUGIN_ID = "signalk-parquet-history-provider";
