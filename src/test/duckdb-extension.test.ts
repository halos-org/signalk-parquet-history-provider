import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
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
import { pinnedDuckdbVersion, resolveExtension } from "../duckdb/extension.js";

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

describe("resolveExtension", () => {
  const version = "1.5.5";
  const platform = "linux_arm64";
  const payload = Buffer.from("not really an extension, but it is bytes");

  function fixture(): { root: string; cacheDir: string; cleanup: () => void } {
    const base = mkdtempSync(join(tmpdir(), "sk-parquet-ext-"));
    const root = join(base, "package");
    const target = join(root, bundledExtensionRelPath(version, platform));
    mkdirSync(dirname(target), { recursive: true });
    const compressed = gzipSync(payload);
    writeFileSync(target, compressed);
    writeFileSync(
      join(root, "extensions", "manifest.json"),
      JSON.stringify({
        duckdbVersion: version,
        platforms: {
          [platform]: {
            sha256: createHash("sha256").update(compressed).digest("hex"),
            bytes: compressed.length,
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

  it("expands the bundled binary into the cache and returns its path", () => {
    const { root, cacheDir, cleanup } = fixture();
    try {
      const path = resolveExtension({ root, cacheDir, platform });
      assert.equal(
        path,
        join(
          cacheDir,
          `v${version}`,
          platform,
          "sqlite_scanner.duckdb_extension",
        ),
      );
      assert.deepEqual(readFileSync(path), payload);
    } finally {
      cleanup();
    }
  });

  it("reuses an already expanded binary", () => {
    const { root, cacheDir, cleanup } = fixture();
    try {
      const first = resolveExtension({ root, cacheDir, platform });
      // Overwrite the cached copy: a second resolve returning the same path
      // without re-expanding is what proves the 27 MB expansion is paid once.
      writeFileSync(first, "already here");
      const second = resolveExtension({ root, cacheDir, platform });
      assert.equal(second, first);
      assert.equal(readFileSync(second, "utf8"), "already here");
    } finally {
      cleanup();
    }
  });

  it("names the platforms it has when asked for one it does not", () => {
    const { root, cacheDir, cleanup } = fixture();
    try {
      assert.throws(
        () => resolveExtension({ root, cacheDir, platform: "osx_arm64" }),
        /linux_arm64/,
      );
    } finally {
      cleanup();
    }
  });

  it("refuses a bundled binary that does not match its checksum", () => {
    const { root, cacheDir, cleanup } = fixture();
    try {
      writeFileSync(
        join(root, bundledExtensionRelPath(version, platform)),
        gzipSync(Buffer.from("a different binary entirely")),
      );
      assert.throws(
        () => resolveExtension({ root, cacheDir, platform }),
        /checksum/,
      );
    } finally {
      cleanup();
    }
  });

  it("says how to get the binaries when none are bundled", () => {
    const base = mkdtempSync(join(tmpdir(), "sk-parquet-ext-"));
    try {
      assert.throws(
        () => resolveExtension({ root: base, cacheDir: join(base, "cache") }),
        /fetch-extensions/,
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
