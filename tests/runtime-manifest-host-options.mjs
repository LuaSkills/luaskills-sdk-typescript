import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostOptionsFromRuntimeManifest } from "../dist/index.js";

// Temporary runtime root used to verify manifest host option path containment.
// 用于校验 manifest 宿主选项路径包含关系的临时 runtime root。
const runtimeRoot = mkdtempSync(join(tmpdir(), "luaskills-manifest-host-options-"));

try {
  const options = hostOptionsFromRuntimeManifest({
    runtime_root: runtimeRoot,
    host_options_patch: {
      sqlite_library_path: "libs/sqlite.dll",
      lancedb_library_path: join(runtimeRoot, "libs", "lancedb.dll"),
      space_controller: {
        executable_path: "bin/vldb-controller.exe",
      },
    },
  });

  assert.equal(options.sqlite_library_path, join(runtimeRoot, "libs", "sqlite.dll"));
  assert.equal(options.space_controller.executable_path, join(runtimeRoot, "bin", "vldb-controller.exe"));

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
