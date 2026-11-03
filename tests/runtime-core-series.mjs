import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import {
  DEFAULT_LUASKILLS_SERIES,
  buildRuntimeInstallManifest,
  embeddedContract,
  installRuntimeAssets,
  resolveRuntimePlatformTarget,
  selectLatestReleaseTagForSeries,
} from "../dist/index.js";

/**
 * Build one USTAR header block; size is the payload byte count.
 * 构造单个 USTAR header block；size 为载荷字节数。
 */
function tarHeader(name, size) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000644\0", 100, "ascii");
  header.write("0000000\0", 108, "ascii");
  header.write("0000000\0", 116, "ascii");
  header.write(`${size.toString(8).padStart(11, "0")}\0`, 124, "ascii");
  header.write("00000000000\0", 136, "ascii");
  header.write("0", 156, 1, "ascii");
  header.write("ustar\0", 257, "ascii");
  header.write("00", 263, "ascii");
  header.fill(0x20, 148, 156);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return header;
}

/**
 * Build one gzip tar archive from a name-to-bytes map; regular files only.
 * 从名称到字节的映射构造单个 gzip tar 归档；仅包含普通文件。
 */
function tarGzip(files) {
  const blocks = [];
  for (const [name, payload] of Object.entries(files)) {
    blocks.push(tarHeader(name, payload.length), payload, Buffer.alloc((512 - (payload.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

// The installer default follows the generated contract series, never a separately pinned core tag.
// 安装器默认值跟随生成契约系列，而不是单独固定的核心标签。
assert.equal(DEFAULT_LUASKILLS_SERIES, embeddedContract.EMBEDDED_CORE_SERIES);

// A fake listing proves newest-patch selection without network: drafts, prereleases, other series and malformed tags are ignored.
// 伪造列表在无网络情况下证明最新补丁选择：忽略草稿、预发布、其他系列及畸形标签。
const listing = [
  { tag_name: "v0.9.0", draft: false, prerelease: false },
  { tag_name: "v0.9.10", draft: false, prerelease: false },
  { tag_name: "v0.9.3", draft: false, prerelease: false },
  { tag_name: "v0.9.11", draft: true, prerelease: false },
  { tag_name: "v0.9.12", draft: false, prerelease: true },
  { tag_name: "v0.10.0", draft: false, prerelease: false },
  { tag_name: "v0.8.9", draft: false, prerelease: false },
  { tag_name: "v0.9.13-rc.1", draft: false, prerelease: false },
  { tag_name: "examples-v0.9.14", draft: false, prerelease: false },
];
assert.equal(selectLatestReleaseTagForSeries(listing, "0.9"), "v0.9.10");
assert.equal(selectLatestReleaseTagForSeries(listing, "0.10"), "v0.10.0");
assert.throws(() => selectLatestReleaseTagForSeries(listing, "0.7", "LuaSkills/luaskills"), /No published release found in series 0\.7 for LuaSkills\/luaskills/);
assert.throws(() => selectLatestReleaseTagForSeries(listing, "0.9.0"), /Invalid release series/);

const workspace = mkdtempSync(join(tmpdir(), "luaskills-core-series-"));
// Preserve the real fetch boundary; restore it on every success or rejection.
// 保存真实 fetch 边界；在每个成功或拒绝路径恢复。
const originalFetch = globalThis.fetch;
try {
  const series = DEFAULT_LUASKILLS_SERIES;
  // Explicit Lua runtime tag keeps every plan offline; only the core tag is under test.
  // 显式 Lua runtime 标签使每个计划保持离线；只测试核心标签。
  const base = { database: "none", luaRuntimeVersion: "v0.1.6", includeLuaRuntime: false, managedRuntimes: "none" };

  // An explicit core tag outside the series is rejected before any request is planned.
  // 系列外的显式核心标签在规划任何请求前被拒绝。
  const [major, minor] = series.split(".").map(Number);
  for (const tag of [`v${major}.${minor + 1}.0`, `v${major}.${minor - 1}.9`, `${series}.0`, `v${series}`, `v${series}.0-rc.1`, ""]) {
    assert.throws(() => buildRuntimeInstallManifest({ ...base, runtimeRoot: join(workspace, "plan"), luaskillsVersion: tag }), /is not a vX\.Y\.Z release of series/, tag);
  }

  // An explicit in-series patch is used exactly as given.
  // 系列内显式补丁版本按原样使用。
  const tag = `v${series}.7`;
  const planned = buildRuntimeInstallManifest({ ...base, runtimeRoot: join(workspace, "plan"), luaskillsVersion: tag });
  const plannedCore = planned.assets.find((entry) => entry.role === "luaskills_ffi");
  assert.ok(plannedCore);
  assert.equal(plannedCore.version, tag);
  assert.match(plannedCore.download_url, new RegExp(`/releases/download/${tag.replaceAll(".", "\\.")}/`));

  const platform = resolveRuntimePlatformTarget();
  const library = Buffer.from("synthetic core library\n");
  const libraryMember = `lib/${platform.luaskills_library_name}`;

  /**
   * Install one synthetic FFI archive through the public installer with only the network boundary replaced.
   * 仅替换网络边界，通过公开安装器安装单个合成 FFI 归档。
   */
  async function install(name, files) {
    const runtimeRoot = join(workspace, name);
    const archive = tarGzip(files);
    const checksum = createHash("sha256").update(archive).digest("hex");
    const options = { ...base, runtimeRoot, luaskillsVersion: tag };
    const asset = buildRuntimeInstallManifest(options).assets.find((entry) => entry.role === "luaskills_ffi");
    globalThis.fetch = async (url) => {
      if (url === asset.sha256_url) return new Response(`${checksum}  ${asset.asset_name}\n`);
      if (url === asset.download_url) return new Response(archive);
      throw new Error(`Unexpected runtime fixture URL: ${url}`);
    };
    return { runtimeRoot, result: installRuntimeAssets(options) };
  }

  // A packaged contract digest that differs from the SDK's is final; nothing reaches the runtime root.
  // 包内契约摘要与 SDK 不同即最终失败；不向 runtime root 写入任何内容。
  const mismatched = await install("mismatch", {
    "contracts/embedded/v1/contract.sha256": Buffer.from(`${"0".repeat(64)}  contract.json\n`),
    [libraryMember]: library,
  });
  await assert.rejects(mismatched.result, /packages embedded contract 0{64}, but this SDK requires/);
  assert.equal(existsSync(join(mismatched.runtimeRoot, "libs", platform.luaskills_library_name)), false);

  // An archive without the contract sidecar is rejected the same way.
  // 缺少契约旁路文件的归档同样被拒绝。
  const missing = await install("missing", { [libraryMember]: library });
  await assert.rejects(missing.result, /does not contain contracts\/embedded\/v1\/contract\.sha256/);
  assert.equal(existsSync(join(missing.runtimeRoot, "libs", platform.luaskills_library_name)), false);

  // The matching digest installs the library.
  // 摘要匹配时安装动态库。
  const matching = await install("match", {
    "contracts/embedded/v1/contract.sha256": Buffer.from(`${embeddedContract.EMBEDDED_CONTRACT_SHA256}  contract.json\n`),
    [libraryMember]: library,
  });
  const installed = await matching.result;
  assert.equal(installed.assets.find((entry) => entry.role === "luaskills_ffi").installed_path, `libs/${platform.luaskills_library_name}`);
  console.log("Runtime core series verified (newest patch selection, out-of-series rejection, packaged contract digest)");
} finally {
  globalThis.fetch = originalFetch;
  rmSync(workspace, { recursive: true, force: true });
}
