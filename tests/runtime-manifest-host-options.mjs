import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostOptionsFromRuntimeManifest, buildRuntimeInstallManifest, defaultHostOptions } from "../dist/index.js";

// Temporary runtime root used to verify manifest host option path containment.
// 用于校验 manifest 宿主选项路径包含关系的临时 runtime root。
const runtimeRoot = mkdtempSync(join(tmpdir(), "luaskills-manifest-host-options-"));

try {
  // A callback preset selects transport only; it never installs a database or a controller.
  // 回调预设仅选择传输；绝不安装数据库或控制器。
  const manifest = buildRuntimeInstallManifest({ runtimeRoot, database: "host-callback", luaRuntimeVersion: "v0.1.6" });
  assert.deepEqual(manifest.assets.map((asset) => asset.role).sort(), ["lua_runtime", "luaskills_ffi"]);
  assert.deepEqual(manifest.host_options_patch, { sqlite_callback_mode: "json" });
  assert.equal(defaultHostOptions(runtimeRoot).host_mode, "console");
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
