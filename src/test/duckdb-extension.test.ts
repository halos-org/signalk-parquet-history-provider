import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import {
  bundledExtensionRelPath,
  duckdbPlatform,
  duckdbVersionFromPackageVersion,
  extensionUrl,
} from "../duckdb/duckdb-version.js";
import {
  pinnedDuckdbVersion,
  ensureExtensionExtracted,
} from "../duckdb/extension.js";

describe("duckdbVersionFromPackageVersion", () => {
  it("strips the wrapper's revision suffix", () => {
    assert.equal(duckdbVersionFromPackageVersion("1.5.5-r.4"), "1.5.5");
    assert.equal(duckdbVersionFromPackageVersion("1.4.5-r.1"), "1.4.5");
  });

  it("accepts a bare version", () => {
    assert.equal(duckdbVersionFromPackageVersion("1.5.5"), "1.5.5");
  });

  it("refuses a range rather than guessing", () => {
    // A caret range is exactly the mistake this guards: it would let an
    // install move the engine away from the bundled extension binary, and
    // the failure would land at LOAD on the device.
    assert.throws(() => duckdbVersionFromPackageVersion("^1.5.5-r.4"));
    assert.throws(() => duckdbVersionFromPackageVersion("latest"));
  });
});

describe("duckdbPlatform", () => {
  it("names the triples DuckDB publishes", () => {
    assert.equal(
      duckdbPlatform({ platform: "linux", arch: "arm64", musl: false }),
      "linux_arm64",
    );
    assert.equal(
      duckdbPlatform({ platform: "linux", arch: "x64", musl: false }),
      "linux_amd64",
    );
    assert.equal(
      duckdbPlatform({ platform: "darwin", arch: "arm64", musl: false }),
      "osx_arm64",
    );
  });

  it("separates musl from glibc", () => {
    // A glibc binary on musl fails at LOAD with a dynamic-linker error that
    // names neither libc, so the triple has to carry it.
    assert.equal(
      duckdbPlatform({ platform: "linux", arch: "arm64", musl: true }),
      "linux_arm64_musl",
    );
  });

  it("throws on a platform DuckDB does not publish for", () => {
    assert.throws(() =>
      duckdbPlatform({ platform: "win32", arch: "arm64", musl: false }),
    );
    assert.throws(() =>
      duckdbPlatform({ platform: "linux", arch: "riscv64", musl: false }),
    );
  });
});

describe("extension locations", () => {
  it("keys the bundle path by version and platform", () => {
    assert.equal(
      bundledExtensionRelPath("1.5.5", "linux_arm64"),
      "extensions/v1.5.5/linux_arm64/sqlite_scanner.duckdb_extension.gz",
    );
  });

  it("builds the upstream URL over https", () => {
    assert.equal(
      extensionUrl("1.5.5", "linux_arm64"),
      "https://extensions.duckdb.org/v1.5.5/linux_arm64/sqlite_scanner.duckdb_extension.gz",
    );
  });
});

describe("pinnedDuckdbVersion", () => {
  it("reads the exact pin out of package.json", () => {
    // Not a fixture: this asserts the real dependency is pinned, because a
    // range here is what silently ships a mismatched extension.
    const root = new URL("../..", import.meta.url).pathname;
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    assert.match(
      pkg.dependencies["@duckdb/node-api"],
      /^\d+\.\d+\.\d+-r\.\d+$/,
    );
    assert.match(pinnedDuckdbVersion(root), /^\d+\.\d+\.\d+$/);
  });
});

describe("ensureExtensionExtracted", () => {
  const platform = "linux_arm64";
  const payload = Buffer.from("not really an extension, but it is bytes");

  function fixture(): { root: string; cacheDir: string; cleanup: () => void } {
    const base = mkdtempSync(join(tmpdir(), "sk-parquet-ext-"));
    const root = join(base, "package");
    // The manifest is checked against this package's own pin, so the fixture
    // uses the real one rather than a literal that would drift out from under
    // the test on the next DuckDB bump.
    const version = pinnedDuckdbVersion(
      new URL("../..", import.meta.url).pathname,
    );
    const target = join(root, bundledExtensionRelPath(version, platform));
    mkdirSync(dirname(target), { recursive: true });
    const compressed = gzipSync(payload);
    writeFileSync(target, compressed);
    mkdirSync(join(root, "node_modules"), { recursive: true });
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        dependencies: { "@duckdb/node-api": `${version}-r.4` },
      }),
    );
    writeFileSync(
      join(root, "extensions", "manifest.json"),
      JSON.stringify({
        duckdbVersion: version,
        platforms: {
          [platform]: {
            sha256: createHash("sha256").update(compressed).digest("hex"),
            bytes: compressed.length,
            expandedBytes: payload.length,
          },
        },
      }),
    );
    return {
      root,
      cacheDir: join(base, "cache"),
      cleanup: () => rmSync(base, { recursive: true, force: true }),
    };
  }

  function cachedPath(root: string, cacheDir: string): string {
    const version = pinnedDuckdbVersion(root);
    return join(
      cacheDir,
      `v${version}`,
      platform,
      "sqlite_scanner.duckdb_extension",
    );
  }

  it("expands the bundled binary into the cache and returns its path", () => {
    const { root, cacheDir, cleanup } = fixture();
    try {
      const path = ensureExtensionExtracted({ root, cacheDir, platform });
      assert.equal(path, cachedPath(root, cacheDir));
      assert.deepEqual(readFileSync(path), payload);
    } finally {
      cleanup();
    }
  });

  it("reuses an already expanded binary of the right length", () => {
    const { root, cacheDir, cleanup } = fixture();
    try {
      const first = ensureExtensionExtracted({ root, cacheDir, platform });
      // Same length, different content: the length check is what makes the
      // 27 MB expansion a once-per-device cost, and it deliberately does not
      // hash on every spawned query process.
      writeFileSync(first, Buffer.alloc(payload.length, 0x5a));
      const second = ensureExtensionExtracted({ root, cacheDir, platform });
      assert.equal(second, first);
      assert.equal(readFileSync(second)[0], 0x5a);
    } finally {
      cleanup();
    }
  });

  it("re-expands a truncated cache entry rather than loading it", () => {
    // What a power cut between the write and the rename leaves behind. The
    // old size > 0 check trusted it forever, and every query on that device
    // failed at LOAD with no way to recover offline.
    const { root, cacheDir, cleanup } = fixture();
    try {
      const path = ensureExtensionExtracted({ root, cacheDir, platform });
      writeFileSync(path, payload.subarray(0, 5));
      assert.deepEqual(
        readFileSync(ensureExtensionExtracted({ root, cacheDir, platform })),
        payload,
      );
    } finally {
      cleanup();
    }
  });

  it("sweeps a temporary left by a process that died mid-expansion", () => {
    // The catch covers a thrown error; it does not cover SIGKILL, an OOM kill
    // or a power cut, and each orphan is 27 MB on the card that also holds
    // the hot store.
    const { root, cacheDir, cleanup } = fixture();
    try {
      const path = ensureExtensionExtracted({ root, cacheDir, platform });
      const directory = dirname(path);
      const orphan = join(directory, "sqlite_scanner.999999.tmp");
      writeFileSync(orphan, "half a binary");
      rmSync(path);
      ensureExtensionExtracted({ root, cacheDir, platform });
      assert.ok(!existsSync(orphan), "the orphaned temporary was left behind");
    } finally {
      cleanup();
    }
  });

  it("refuses a bundled binary the manifest does not describe", () => {
    // The fetch script writes binaries inside its loop and the manifest only
    // after it, so an interrupted fetch leaves exactly this state. Skipping
    // the checksum here would mean the integrity check does nothing in the
    // one case where something has already gone wrong.
    const { root, cacheDir, cleanup } = fixture();
    try {
      const version = pinnedDuckdbVersion(root);
      const rogue = join(root, bundledExtensionRelPath(version, "linux_amd64"));
      mkdirSync(dirname(rogue), { recursive: true });
      writeFileSync(rogue, gzipSync(Buffer.from("unlisted and unverified")));
      assert.throws(
        () =>
          ensureExtensionExtracted({
            root,
            cacheDir,
            platform: "linux_amd64",
          }),
        /not for linux_amd64/,
      );
    } finally {
      cleanup();
    }
  });

  it("names the platforms it has when asked for one it does not", () => {
    const { root, cacheDir, cleanup } = fixture();
    try {
      assert.throws(
        () =>
          ensureExtensionExtracted({ root, cacheDir, platform: "osx_arm64" }),
        /linux_arm64/,
      );
    } finally {
      cleanup();
    }
  });

  it("refuses a bundled binary that does not match its checksum", () => {
    const { root, cacheDir, cleanup } = fixture();
    try {
      const version = pinnedDuckdbVersion(root);
      writeFileSync(
        join(root, bundledExtensionRelPath(version, platform)),
        gzipSync(Buffer.from("a different binary entirely")),
      );
      assert.throws(
        () => ensureExtensionExtracted({ root, cacheDir, platform }),
        /checksum/,
      );
    } finally {
      cleanup();
    }
  });

  it("refuses a manifest for a different DuckDB than the package pins", () => {
    const { root, cacheDir, cleanup } = fixture();
    try {
      const manifestPath = join(root, "extensions", "manifest.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      manifest.duckdbVersion = "0.0.1";
      writeFileSync(manifestPath, JSON.stringify(manifest));
      assert.throws(
        () => ensureExtensionExtracted({ root, cacheDir, platform }),
        /pins/,
      );
    } finally {
      cleanup();
    }
  });

  it("refuses a manifest it cannot read rather than failing later", () => {
    const { root, cacheDir, cleanup } = fixture();
    try {
      writeFileSync(
        join(root, "extensions", "manifest.json"),
        JSON.stringify({ duckdbVersion: "1.5.5" }),
      );
      assert.throws(
        () => ensureExtensionExtracted({ root, cacheDir, platform }),
        /not a readable extension manifest/,
      );
    } finally {
      cleanup();
    }
  });

  it("says how to get the binaries when none are bundled", () => {
    const base = mkdtempSync(join(tmpdir(), "sk-parquet-ext-"));
    try {
      assert.throws(
        () =>
          ensureExtensionExtracted({
            root: base,
            cacheDir: join(base, "cache"),
          }),
        /fetch-extensions/,
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
