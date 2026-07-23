import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Directory that contains all built-output JavaScript test entrypoints.
// 包含所有构建产物 JavaScript 测试入口的目录。
const testDirectory = dirname(fileURLToPath(import.meta.url));

// Ordered test entrypoints that must run after one shared package build.
// 在一次共享包构建之后按顺序运行的测试入口。
const testFiles = [
  "private-url-manifest.mjs",
  "runtime-lease-actions.mjs",
  "skill-lifecycle-actions.mjs",
  "skill-install-source-types.mjs",
  "skill-package-config.mjs",
  "skill-config-contract.mjs",
  "skill-config-native-e2e.mjs",
  "skill-operation-progress-callback.mjs",
  "system-management-raw-call-boundary.mjs",
  "client-lifecycle-boundary.mjs",
  "ffi-envelope-errors.mjs",
  "runtime-manifest-errors.mjs",
  "runtime-manifest-host-options.mjs",
  "runtime-archive-validation.mjs",
  "runtime-checksum-validation.mjs",
  "runtime-managed-path-validation.mjs",
  "managed-runtime-host-roots.mjs",
];

for (const testFile of testFiles) {
  runTestFile(testFile);
}

/**
 * Run one already-built Node.js test file and fail fast on errors.
 * 运行单个已构建的 Node.js 测试文件，并在出错时快速失败。
 */
function runTestFile(testFile) {
  const result = spawnSync(process.execPath, [join(testDirectory, testFile)], {
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
