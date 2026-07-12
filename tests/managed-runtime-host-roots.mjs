import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  LuaSkillsClient,
  createEngineOptions,
  defaultHostOptions,
  defaultManagedRuntimeConfig,
  resolveManagedRuntimePlatformTarget,
} from "../dist/index.js";

// RuntimeRoot exercises default JSON payload construction without loading the native library.
// RuntimeRoot 覆盖不加载原生库时的默认 JSON 载荷构造。
const runtimeRoot = mkdtempSync(join(tmpdir(), "LuaSkills 运行根 "));
try {
  // HostOptions is the complete JSON object passed to engine creation.
  // HostOptions 是传给引擎创建流程的完整 JSON 对象。
  const hostOptions = defaultHostOptions(runtimeRoot);
  assert.equal(hostOptions.managed_runtime_distribution_root, null);
  assert.equal(hostOptions.managed_runtime_environment_root, null);
  assert.deepEqual(hostOptions.managed_runtime_config, defaultManagedRuntimeConfig());
  // ManagedRuntimeConfig uses nondefault values to prove host-option merging preserves B3-B7.
  // ManagedRuntimeConfig 使用非默认值，证明宿主选项合并会保留 B3-B7。
  const managedRuntimeConfig = {
    worker_pool_max_size_per_environment: 6,
    worker_idle_ttl_secs: 30,
    persistent_session_limit_per_engine: 64,
    persistent_session_default_buffer_limit_bytes_per_stream: 262_144,
    invoke_default_timeout_ms: 12_000,
  };
  // EngineOptions is the exact JSON payload produced by the public SDK helper.
  // EngineOptions 是公共 SDK 辅助器生成的精确 JSON 载荷。
  const engineOptions = createEngineOptions({
    runtimeRoot,
    hostOptions: { managed_runtime_config: managedRuntimeConfig },
  });
  assert.deepEqual(engineOptions.host_options.managed_runtime_config, managedRuntimeConfig);
} finally {
  rmSync(runtimeRoot, { recursive: true, force: true });
}

assert.throws(
  () => LuaSkillsClient.resolveManagedRuntimeInstall({
    distributionRoot: "D:/shared",
    runtime: "ruby",
    version: "3.3.0",
    platform: "windows-x64",
  }),
  /runtime must be either/,
);

// RelativeDistributionRoot must fail before native library discovery or filesystem probing.
// RelativeDistributionRoot 必须在原生库发现或文件系统探测前失败。
assert.throws(
  () => LuaSkillsClient.resolveManagedRuntimeInstall({
    distributionRoot: "relative/managed-runtimes",
    runtime: "python",
    version: "3.14.4",
    platform: "windows-x64",
  }),
  /distributionRoot must be an absolute path/,
);

// RuntimeLibrary enables the real native round trip in integration-capable environments.
// RuntimeLibrary 在具备集成条件的环境中启用真实原生往返调用。
const runtimeLibrary = process.env.LUASKILLS_LIB;
if (runtimeLibrary) {
  // DistributionRoot is the isolated host-owned asset root.
  // DistributionRoot 是隔离的宿主自有资产根。
  const distributionRoot = mkdtempSync(join(tmpdir(), "LuaSkills SDK 发行根 "));
  try {
    // Target is the authoritative SDK mapping for the current native runner.
    // Target 是当前原生 runner 的权威 SDK 映射。
    const target = resolveManagedRuntimePlatformTarget();
    // InstallRoot follows the exact Rust Node installation naming contract.
    // InstallRoot 遵循精确 Rust Node 安装命名契约。
    const installRoot = join(
      distributionRoot,
      "node",
      `node-24.18.0-${target.platform_key}`,
    );
    // ExecutablePath follows the published archive layout for this runner.
    // ExecutablePath 遵循当前 runner 的已发布归档布局。
    const executablePath = join(installRoot, target.node_executable);
    mkdirSync(dirname(executablePath), { recursive: true });
    writeFileSync(executablePath, "node executable", "utf8");
    writeFileSync(
      join(installRoot, "runtime-manifest.json"),
      JSON.stringify({
        schema_version: 1,
        runtime: "node",
        version: "24.18.0",
        platform: target.platform_key,
        executable: target.node_executable,
      }),
      "utf8",
    );

    // Descriptor is decoded from the real native response envelope.
    // Descriptor 从真实原生响应包络解码。
    const descriptor = LuaSkillsClient.resolveManagedRuntimeInstall({
      libraryPath: runtimeLibrary,
      distributionRoot,
      runtime: "node",
      version: "24.18.0",
      platform: target.platform_key,
    });
    assert.equal(realpathSync.native(descriptor.install_root), realpathSync.native(installRoot));
    assert.equal(realpathSync.native(descriptor.executable), realpathSync.native(executablePath));
    assert.equal(descriptor.manifest_hash.length, 64);
    assert.equal(descriptor.executable_hash.length, 64);
  } finally {
    rmSync(distributionRoot, { recursive: true, force: true });
  }
}
