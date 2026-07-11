import assert from "node:assert/strict";
import { decodeRuntimeInstallManifest } from "../dist/index.js";

// Manifest path used to prove diagnostics keep file context.
// 用于证明诊断保留文件上下文的清单路径。
const manifestPath = "runtime/resources/luaskills-sdk-runtime-manifest.json";

assert.throws(
  () => decodeRuntimeInstallManifest(manifestPath, ""),
  /runtime install manifest runtime\/resources\/luaskills-sdk-runtime-manifest\.json is empty/,
);

assert.throws(
  () => decodeRuntimeInstallManifest(manifestPath, "{"),
  /runtime install manifest runtime\/resources\/luaskills-sdk-runtime-manifest\.json is invalid JSON/,
);

assert.throws(
  () => decodeRuntimeInstallManifest(manifestPath, "[1]"),
  /runtime install manifest runtime\/resources\/luaskills-sdk-runtime-manifest\.json must be one JSON object/,
);
