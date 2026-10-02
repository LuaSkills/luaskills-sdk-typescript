import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyDistribution } from "./verify-embedded-distribution.mjs";

/**
 * Require an explicit absolute regular file and return its canonical path.
 * 要求显式绝对普通文件并返回其规范路径。
 * @param {string} filename Exact caller-selected path.
 * 调用者选择的精确路径。
 * @param {string} label Input name for an actionable failure.
 * 用于明确错误提示的输入名称。
 * @returns {string} Canonical file path; missing or relative inputs always fail.
 * 规范文件路径；缺失或相对输入一律失败。
 */
function inputFile(filename, label) {
  assert.equal(typeof filename, "string", `${label} is required`);
  assert.ok(isAbsolute(filename), `${label} must be absolute`);
  assert.ok(statSync(filename).isFile(), `${label} must be a regular file`);
  return realpathSync(filename);
}

/**
 * Install the exact locally packed archive independently and run its real embedded example.
 * 独立安装精确本地打包归档并运行其中真实嵌入式示例。
 * @param {string} archive Absolute npm tgz built from this checkout.
 * 本检出构建的 npm tgz 绝对路径。
 * @param {string} libraryPath Absolute frozen candidate native library.
 * 冻结候选原生库绝对路径。
 * @param {string} librarySha256 Frozen binary SHA-256 from the candidate owner.
 * 候选所有者提供的冻结二进制 SHA-256。
 * @param {string} descriptionPath Absolute frozen OutputCoreDescription JSON file.
 * 冻结 OutputCoreDescription JSON 文件的绝对路径。
 * @returns {void} Completes only after artifact, identity, real callback and native cleanup checks pass.
 * 仅在产物、身份、真实回调及原生清理检查通过后完成。
 */
export function verifyCandidate(archive, libraryPath, librarySha256, descriptionPath) {
  // Validate the native selection before npm work so a missing core cannot become an offline-only pass.
  // npm 工作前校验原生选择，防止缺失核心变成仅离线通过。
  const library = inputFile(libraryPath, "Candidate library");
  assert.match(librarySha256, /^[0-9a-f]{64}$/, "Candidate library SHA-256 must be a frozen lowercase digest");
  assert.equal(createHash("sha256").update(readFileSync(library)).digest("hex"), librarySha256, "Candidate library SHA-256 mismatch");
  // Snapshot the owner's description once; installation must not change which identity was approved.
  // 一次性快照所有者描述；安装不得改变已指定身份。
  const description = inputFile(descriptionPath, "Frozen core description");
  const descriptionBytes = readFileSync(description);
  JSON.parse(descriptionBytes.toString("utf8"));
  // The artifact path is equally explicit and cannot be selected by modification time.
  // 产物路径同样显式，不能按修改时间选择。
  const filename = inputFile(archive, "npm archive");
  // npm supplies its actual CLI file; execute it with Node rather than an interpolated shell command.
  // npm 提供其实际 CLI 文件；用 Node 执行，避免插值 shell 命令。
  const npmCli = inputFile(process.env.npm_execpath, "npm_execpath (invoke npm run test:embedded-candidate)");
  verifyDistribution(filename);
  // Independent installation owns only this newly created temporary directory.
  // 独立安装仅拥有此新建临时目录。
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), "luaskills-candidate-consumer-")));
  try {
    // Pin the FFI dependency to this checkout's actual lock identity, including its registry and integrity.
    // 将 FFI 依赖固定到本检出实际锁身份，包括其注册表与完整性摘要。
    const lock = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package-lock.json"), "utf8"));
    // Use the current lock's sole authoritative FFI package record.
    // 使用当前锁文件唯一权威 FFI 包记录。
    const koffiLock = lock.packages["node_modules/koffi"];
    assert.equal(typeof koffiLock.version, "string", "Locked Koffi version is required");
    assert.equal(typeof koffiLock.resolved, "string", "Locked Koffi registry identity is required");
    assert.equal(typeof koffiLock.integrity, "string", "Locked Koffi integrity is required");
    // The consumer pins that exact dependency while installing the SDK from the supplied archive.
    // 消费端固定该精确依赖，同时从指定归档安装 SDK。
    const consumer = { name: "luaskills-candidate-consumer", private: true, type: "module", dependencies: { koffi: koffiLock.version } };
    writeFileSync(join(temporary, "package.json"), JSON.stringify(consumer));
    writeFileSync(join(temporary, "package-lock.json"), JSON.stringify({ name: consumer.name, lockfileVersion: 3, requires: true, packages: { "": consumer, "node_modules/koffi": koffiLock } }));
    // npm run promotes npmrc allow-scripts into env; npm 11 rejects that env source for project installs.
    // npm run 将 npmrc allow-scripts 提升为环境变量；npm 11 拒绝项目安装使用该环境来源。
    // Let the child read the unchanged npmrc policy itself while --ignore-scripts remains mandatory.
    // 让子进程自行读取未修改的 npmrc 策略，同时保持强制 --ignore-scripts。
    const installEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== "npm_config_allow_scripts"));
    // Offline dependency resolution uses the local npm cache and never fetches a different SDK or core.
    // 离线依赖解析使用本地 npm 缓存，绝不获取另一 SDK 或核心。
    execFileSync(process.execPath, [npmCli, "install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", filename], { cwd: temporary, stdio: "pipe", encoding: "utf8", timeout: 60000, env: installEnvironment });
    // This exact package directory is the only SDK source for the child process.
    // 此精确包目录是子进程唯一 SDK 来源。
    const installed = join(temporary, "node_modules", "@luaskills", "sdk");
    // The installed package must be a physical independent copy, never a link back to the checkout.
    // 已安装包必须是物理独立副本，绝不能链接回检出目录。
    assert.equal(realpathSync(installed), installed);
    execFileSync(process.execPath, [join(installed, "scripts", "generate-embedded-contract.mjs"), "--check"], { cwd: temporary, stdio: "pipe", timeout: 30000 });
    // Pass the frozen snapshot rather than rereading a mutable owner path in the consumer.
    // 将冻结快照传入消费端，不在那里重读可变所有者路径。
    const snapshot = join(temporary, "core-description.json");
    writeFileSync(snapshot, descriptionBytes);
    // Resolve the public entry from the consumer and then execute only files in its installed package.
    // 从消费端解析公共入口，随后仅执行其安装包中的文件。
    writeFileSync(join(temporary, "consumer.mjs"), `import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import * as sdk from '@luaskills/sdk';
import {runEmbeddedCandidate} from './node_modules/@luaskills/sdk/examples/embedded-candidate.mjs';
import {runEmbeddedValuePolicy} from './node_modules/@luaskills/sdk/examples/embedded-value-policy.mjs';
assert.equal(fileURLToPath(import.meta.resolve('@luaskills/sdk')), process.argv[4]);
// Contract bytes come only from the independent installed artifact.
// 契约字节仅来自独立安装产物。
const bytes=readFileSync(new URL('./node_modules/@luaskills/sdk/contracts/embedded/v1/contract.json',import.meta.url));
assert.equal(sdk.embeddedContract.EMBEDDED_CONTRACT_SHA256,createHash('sha256').update(bytes).digest('hex'));
// Native completion is reported only after the example proves all owned release checkpoints.
// 仅在示例证明所有拥有型释放检查点后报告原生完成。
const result=await runEmbeddedCandidate(process.argv[2],readFileSync(process.argv[3]));
// Policy acceptance runs only the independent installed module and preserves the original result schema.
// 政策验收仅运行独立安装模块，并保留原结果结构。
await runEmbeddedValuePolicy(process.argv[2],readFileSync(process.argv[3]));
process.stdout.write(JSON.stringify(result)+'\\n');
`);
    // One bounded child executes actual installed code and propagates every native failure.
    // 一个有界子进程执行实际已安装代码并传播每个原生失败。
    const evidence = execFileSync(process.execPath, [join(temporary, "consumer.mjs"), library, snapshot, join(installed, "dist", "index.js")], { cwd: temporary, stdio: "pipe", encoding: "utf8", timeout: 60000, env: { ...process.env, LUASKILLS_LIB: library } });
    // Recheck selected bytes after execution so changes during validation cannot silently pass.
    // 执行后再次核验所选字节，防止验证期间变化静默通过。
    assert.equal(createHash("sha256").update(readFileSync(library)).digest("hex"), librarySha256, "Candidate library changed during validation");
    assert.deepEqual(readFileSync(description), descriptionBytes, "Frozen description changed during validation");
    process.stdout.write(evidence);
    process.stdout.write("Embedded candidate npm gate verified (independent install, native callbacks, owned close)\n");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

// This gate has no skip path; all four candidate inputs must be explicitly supplied.
// 本门禁没有跳过路径；必须显式提供全部四项候选输入。
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 6) throw new Error("Usage: npm run test:embedded-candidate -- <absolute-archive.tgz> <absolute-library> <library-sha256> <absolute-description.json>");
  verifyCandidate(...process.argv.slice(2));
}
