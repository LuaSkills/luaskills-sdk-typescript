import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostOptionsFromRuntimeManifest, buildRuntimeInstallManifest, defaultHostOptions, DEFAULT_LUASKILLS_SERIES, RuntimeRoots } from "../dist/index.js";

// Temporary runtime root used to verify manifest host option path containment.
// 用于校验 manifest 宿主选项路径包含关系的临时 runtime root。
const runtimeRoot = mkdtempSync(join(tmpdir(), "luaskills-manifest-host-options-"));

try {
  // A callback preset selects transport only; it never installs a database or a controller.
  // 回调预设仅选择传输；绝不安装数据库或控制器。
  // Explicit in-series core and Lua runtime tags keep the plan offline.
  // 显式的系列内核心标签及 Lua runtime 标签使计划保持离线。
  const manifest = buildRuntimeInstallManifest({ runtimeRoot, database: "host-callback", luaRuntimeVersion: "v0.1.6", luaskillsVersion: `v${DEFAULT_LUASKILLS_SERIES}.0` });
  assert.deepEqual(manifest.assets.map((asset) => asset.role).sort(), ["lua_runtime", "luaskills_ffi"]);
  assert.deepEqual(manifest.host_options_patch, { sqlite_callback_mode: "json" });
  assert.equal(defaultHostOptions(runtimeRoot).host_mode, "console");
  // Writable directories stay derived from runtime_root unless the host opts in.
  // 除非宿主显式开启，可写目录仍从 runtime_root 推导。
  assert.equal(defaultHostOptions(runtimeRoot).preserve_host_writable_dirs, false);
  // Host-kept writable directories leave the derived temp layout uncreated; the default layout still creates it.
  // 宿主保留可写目录时不创建推导的临时目录布局；默认布局仍会创建。
  const keptRoot = join(runtimeRoot, "kept");
  RuntimeRoots.ensureLayout(keptRoot, undefined, { preserveHostWritableDirs: true });
  assert.equal(existsSync(join(keptRoot, "temp")), false);
  assert.equal(existsSync(join(keptRoot, "resources")), true);
  const derivedRoot = join(runtimeRoot, "derived");
  RuntimeRoots.ensureLayout(derivedRoot);
  assert.equal(existsSync(join(derivedRoot, "temp", "downloads")), true);
  for (const database of ["vldb-controller", "vldb-direct"]) {
    assert.throws(() => buildRuntimeInstallManifest({ runtimeRoot, database, luaRuntimeVersion: "v0.1.6" }), /Unsupported database preset/i);
  }
  for (const key of ["sqlite_library_path", "sqlite_provider_mode", "lancedb_library_path", "lancedb_provider_mode", "lancedb_callback_mode", "space_controller"]) {
    assert.throws(() => hostOptionsFromRuntimeManifest({ runtime_root: runtimeRoot, host_options_patch: { [key]: null } }), new RegExp(key));
  }
  const options = hostOptionsFromRuntimeManifest({
    runtime_root: runtimeRoot,
    host_options_patch: {
      host_mode: "desktop",
      sqlite_callback_mode: "json",
    },
  });
  assert.equal(options.host_mode, "desktop");
  assert.equal(options.sqlite_callback_mode, "json");

  assert.throws(
    () => hostOptionsFromRuntimeManifest({
      runtime_root: runtimeRoot,
      host_options_patch: {
        sqlite_library_path: "../outside.dll",
      },
    }),
    /sqlite_library_path/,
  );

  assert.throws(
    () => hostOptionsFromRuntimeManifest({
      runtime_root: runtimeRoot,
      host_options_patch: {
        space_controller: "not-an-object",
      },
    }),
    /space_controller/,
  );
} finally {
  rmSync(runtimeRoot, { recursive: true, force: true });
}
