import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  buildRuntimeInstallManifest,
  installRuntimeAssets,
  runtimeManifestPath,
  validateArchiveLinkTarget,
  validateArchiveMemberPath,
  validateArchiveMembers,
  validateTarMemberType,
} from "../dist/index.js";

// Temporary destination used to evaluate archive member path containment.
// 用于评估归档成员路径包含关系的临时目标目录。
const destination = mkdtempSync(join(tmpdir(), "luaskills-archive-validation-"));

try {
  assert.doesNotThrow(() => validateArchiveMemberPath(destination, "safe/file.txt"));
  assert.throws(
    () => validateArchiveMemberPath(destination, "../evil.txt"),
    /Archive member escapes extraction directory/,
  );
  assert.throws(
    () => validateArchiveMemberPath(destination, ""),
    /Unsafe archive member path/,
  );
  assert.throws(
    () => validateArchiveMemberPath(destination, "C:\\outside.txt"),
    /Unsafe archive member path/,
  );

  assert.doesNotThrow(() => validateArchiveLinkTarget(destination, "safe/link", "../target.txt"));
  assert.throws(
    () => validateArchiveLinkTarget(destination, "safe/link", "../../evil.txt"),
    /Archive member escapes extraction directory/,
  );
  assert.throws(
    () => validateArchiveLinkTarget(destination, "safe/link", "C:\\outside.txt"),
    /Unsafe archive link target/,
  );

  for (const safeType of ["", "0", "1", "2", "5"]) {
    assert.doesNotThrow(() => validateTarMemberType(safeType, "safe/member"));
  }
  for (const unsafeType of ["3", "4", "6"]) {
    assert.throws(
      () => validateTarMemberType(unsafeType, "unsafe/member"),
      /Unsupported tar member type/,
    );
  }
} finally {
  rmSync(destination, { recursive: true, force: true });
}

// Select the explicit BSD ZIP control only when requested; ordinary runs exercise tar.gz installation.
// 仅在明确请求时选择 BSD ZIP 对照；普通运行验证 tar.gz 安装。
assert.ok(process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === "--zip-install-fixture"));
const zipFixture = process.argv.length === 3;
// Freeze local payload bytes; no installed runtime or executable is invoked by this fixture.
// 冻结本地内容字节；此夹具不调用已安装的运行时或可执行文件。
const payload = Buffer.from("local runtime archive fixture\n");
// This ordinary USTAR gzip contains one runtime marker and one package file.
// 此普通 USTAR gzip 包含一个运行时标记及一个包文件。
const tarGzip = Buffer.from("H4sIAAAAAAAC/+3UywrCMBCF4ax9iuC+NdZSwZeRUKJWe5FcpCC+u1EKQjculCL4f5sJs5lF5ow1rgu2NG5RB53Y0PqqMUmj22pnnE+PrmvFp1RU5PmzRuOqVJa93o/+Ml8vMyGVmEBwXts4Xvyn63xX9T5YM99Ib4O5zQT+SEz99qzLk97HEzCsQup7/80Zb/O/Kkb5zwryP9H/d6Wu5XD3pbbloboYOSwCtwAAAAAAAAAAAAAAAODn3QE8s0upACgAAA==", "base64");
// The stored ZIP contains the same payload under the declared controller filename for the Windows BSD control.
// 此 stored ZIP 将同一内容放在已声明控制器文件名下，用于 Windows BSD 对照。
const zipArchive = Buffer.from("UEsDBBQAAAAAAAAAIQDdHxsMHgAAAB4AAAATAAAAdmxkYi1jb250cm9sbGVyLmV4ZWxvY2FsIHJ1bnRpbWUgYXJjaGl2ZSBmaXh0dXJlClBLAQIUABQAAAAAAAAAIQDdHxsMHgAAAB4AAAATAAAAAAAAAAAAAACkgQAAAAB2bGRiLWNvbnRyb2xsZXIuZXhlUEsFBgAAAAABAAEAQQAAAE8AAAAAAA==", "base64");
// Own only this independent install root and ordinary tar listing fixture.
// 仅拥有这个独立安装根及普通 tar 列目录夹具。
const installation = mkdtempSync(join(tmpdir(), "luaskills-archive-install-"));
// Preserve the real fetch boundary; restore it on every success or rejection.
// 保存真实 fetch 边界；在每个成功或拒绝路径恢复。
const originalFetch = globalThis.fetch;
try {
  // Declare a fixed version so the public builder never queries the release series online.
  // 声明固定版本，避免公开构造器在线查询发布系列。
  const fixtureVersion = "v0.0.0-test";
  // Use the original public installer, selecting exactly one archive role without managed-runtime execution.
  // 使用原公开安装器，选择唯一归档角色而不执行受管运行时。
  const options = {
    runtimeRoot: join(installation, "runtime"), database: zipFixture ? "vldb-controller" : "none",
    luaRuntimeVersion: fixtureVersion, vldbControllerVersion: fixtureVersion,
    includeLuaRuntime: !zipFixture, includeLuaSkillsFfi: false, managedRuntimes: "none",
  };
  // Freeze the actual public URL descriptors before substituting only the network boundary.
  // 在仅替换网络边界前冻结实际公开 URL 描述符。
  const planned = buildRuntimeInstallManifest(options);
  assert.equal(planned.assets.length, 1);
  // Locate by the declared role rather than a positional asset index.
  // 按声明角色定位，不使用位置资产下标。
  const role = zipFixture ? "vldb_controller" : "lua_runtime";
  const asset = planned.assets.find((entry) => entry.role === role);
  assert.ok(asset, "The declared local archive role must exist");
  assert.ok(!zipFixture || asset.asset_name.endsWith(".zip"), "The ZIP control requires the Windows platform descriptor");
  // Select only the declared fixture format and compute its real checksum for the production verifier.
  // 仅选择已声明夹具格式，并计算真实摘要供生产校验器使用。
  const archive = zipFixture ? zipArchive : tarGzip;
  const checksum = createHash("sha256").update(archive).digest("hex");
  // Record exact requested public URLs without admitting any unknown network request.
  // 记录精确请求的公开 URL，不接纳任何未知网络请求。
  const requests = [];
  /**
   * Serve only the exact archive and sidecar URL; url is the production string and init must remain absent.
   * 仅提供精确归档及旁路 URL；url 为生产字符串，init 必须保持未传入。
   * Return fixed local Response bytes; any unknown request fails instead of reaching a network.
   * 返回固定本地 Response 字节；任何未知请求均失败，不连接网络。
   */
  globalThis.fetch = async (url, init) => {
    assert.equal(typeof url, "string");
    assert.equal(init, undefined);
    requests.push(url);
    if (url === asset.sha256_url) return new Response(`${checksum}  ${asset.asset_name}\n`);
    if (url === asset.download_url) return new Response(archive);
    throw new Error(`Unexpected runtime fixture URL: ${url}`);
  };
  // Exercise actual system tar through the production extraction path and preserve installed member bytes.
  // 通过生产解压路径执行实际系统 tar，并核对安装成员字节。
  const installed = await installRuntimeAssets(options);
  assert.deepEqual(requests, [asset.sha256_url, asset.download_url]);
  // Observe the installed role by identity and its declared installed-path projection.
  // 按身份观察已安装角色及其声明的安装路径投影。
  const installedAsset = installed.assets.find((entry) => entry.role === role);
  assert.ok(installedAsset);
  // Match the original role-specific installation contract rather than the archive's temporary path.
  // 匹配原角色专属安装契约，不使用归档的临时路径。
  const expectedPath = zipFixture ? "bin/vldb-controller.exe" : "resources/lua-runtime-manifest.json";
  assert.equal(installedAsset.installed_path, expectedPath);
  assert.deepEqual(readFileSync(join(options.runtimeRoot, zipFixture ? expectedPath : "lua_packages/fixture.txt")), payload);
  assert.equal(JSON.parse(readFileSync(runtimeManifestPath(options.runtimeRoot), "utf8")).assets.length, 1);
  // An ordinary uncompressed tar uses the public member-listing path instead of the gzip parser.
  // 普通未压缩 tar 使用公开成员列表路径，而不是 gzip 解析器。
  const ordinaryTar = join(installation, "ordinary.tar");
  writeFileSync(ordinaryTar, gunzipSync(tarGzip));
  await validateArchiveMembers(ordinaryTar, installation);
  console.log(`Runtime archive fixture verified (${zipFixture ? "zip" : "tar.gz"}, actual install and ordinary tar listing)`);
} finally {
  globalThis.fetch = originalFetch;
  rmSync(installation, { recursive: true, force: true });
}
