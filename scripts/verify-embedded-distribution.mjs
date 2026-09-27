import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Verify actual npm archive bytes and rebuild its contract in an isolated directory.
 * 验证实际 npm 归档字节，并在隔离目录内重建其契约。
 * @param {string} archive Explicit locally built npm archive path.
 * 显式本地构建的 npm 归档路径。
 * @returns {void} Throws on missing, changed or non-portable embedded artifacts.
 * 嵌入式产物缺失、变更或不可移植时抛错。
 */
export function verifyDistribution(archive) {
  // The system tar reads exact members to stdout; arbitrary archive paths are never extracted.
  // 系统 tar 将精确成员读到标准输出；不会解压任意归档路径。
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const filename = resolve(archive);
  const members = execFileSync("tar", ["-tzf", filename], { encoding: "utf8" }).trimEnd().split(/\r?\n/);
  assert.equal(new Set(members).size, members.length, "Duplicate archive members");
  // Only these explicitly declared files may be materialized under the isolated directory.
  // 仅可将这些显式声明文件落盘到隔离目录内。
  const expected = ["package.json", "contracts/embedded/v1/contract.json", "contracts/embedded/v1/contract.sha256", "contracts/embedded/v1/README.md", "scripts/generate-embedded-contract.mjs", "scripts/verify-embedded-distribution.mjs", "src/embedded-contract.ts", "dist/embedded-contract.js", "dist/embedded-contract.d.ts", "dist/embedded-contract.js.map", "src/index.ts", "dist/index.js", "dist/index.d.ts"];
  // Public value types stay independent of Node globals; codec and transport artifacts are checked separately.
  // 公开值类型保持独立于 Node 全局；编码器和传输产物分别校验。
  for (const name of ["embedded-value", "embedded-json", "embedded-transport", "embedded-driver", "embedded-worker", "embedded-worker-protocol", "embedded-worker-runtime", "embedded-callbacks", "embedded-pump", "embedded-observation", "embedded-client", "embedded-scope", "client", "types"]) expected.push(`src/${name}.ts`, `dist/${name}.js`, `dist/${name}.d.ts`, `dist/${name}.js.map`);
  const temporary = mkdtempSync(join(tmpdir(), "luaskills-embedded-npm-"));
  try {
    for (const relative of expected) {
      assert.ok(members.includes(`package/${relative}`), `Missing npm member: ${relative}`);
      const bytes = execFileSync("tar", ["-xOzf", filename, `package/${relative}`]);
      assert.deepEqual(bytes, readFileSync(join(root, relative)), `Changed npm bytes: ${relative}`);
      const output = join(temporary, relative);
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, bytes);
    }
    // Standalone generation must use only its packaged contract, without compiler or native dependencies.
    // 独立生成必须仅使用包内契约，不依赖编译器或原生组件。
    execFileSync(process.execPath, [join(temporary, "scripts/generate-embedded-contract.mjs"), "--check"], { cwd: temporary, stdio: "pipe" });
    // A fresh interpreter imports the actual packaged JavaScript and verifies its runtime identity.
    // 新解释器导入实际包内 JavaScript 并核对运行时身份。
    const check = `import assert from 'node:assert/strict'; import {readFileSync} from 'node:fs'; import {createHash} from 'node:crypto';
const contract = await import(process.argv[1]);
const bytes = readFileSync('contracts/embedded/v1/contract.json');
const document = JSON.parse(bytes);
assert.equal(contract.EMBEDDED_CONTRACT_SHA256, createHash('sha256').update(bytes).digest('hex'));
assert.deepEqual(contract.EMBEDDED_ROOT_COMMANDS, document.commands);
assert.deepEqual(contract.EMBEDDED_RUNTIME_COMMANDS, document.runtime_commands);
assert.ok(Object.isFrozen(contract.EMBEDDED_ROOT_COMMANDS));
assert.ok(Object.isFrozen(contract.EmbeddedNativeStatus));`;
    execFileSync(process.execPath, ["--input-type=module", "-e", check, pathToFileURL(join(temporary, "dist/embedded-contract.js")).href], { cwd: temporary, stdio: "pipe" });
    // The codec executes from the actual package without loading Koffi or borrowing repository modules.
    // 编码器从实际包执行，不加载 Koffi，也不借用仓库模块。
    const codecCheck = `import assert from 'node:assert/strict'; import {readFileSync} from 'node:fs'; const codec = await import(process.argv[1]);
const value = { integer: 18446744073709551615n, float: new codec.EmbeddedFloat(1e100), empty: null };
assert.deepEqual(codec.decodeEmbeddedJson(codec.encodeEmbeddedJson(value, 4096)), value);
const vectors = JSON.parse(readFileSync('contracts/embedded/v1/contract.json', 'utf8')).json_vectors;
assert.equal(vectors.version, 1);
for (const entry of vectors.valid) {
  const original = codec.decodeEmbeddedJson(Buffer.from(entry.json));
  assert.deepEqual(codec.decodeEmbeddedJson(codec.encodeEmbeddedJson(original, 4096)), original, entry.id);
}
for (const entry of vectors.invalid) assert.throws(() => codec.decodeEmbeddedJson(Buffer.from(entry.json)), entry.id);
for (const entry of vectors.invalid_bytes) assert.throws(() => codec.decodeEmbeddedJson(Buffer.from(entry.hex, 'hex')), entry.id);`;
    execFileSync(process.execPath, ["--input-type=module", "-e", codecCheck, pathToFileURL(join(temporary, "dist/embedded-json.js")).href], { cwd: temporary, stdio: "pipe" });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

// Explicit archive selection prevents verification from silently choosing an old build.
// 显式选择归档，避免验证时静默选中旧构建。
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error("Usage: node scripts/verify-embedded-distribution.mjs <archive.tgz>");
  verifyDistribution(process.argv[2]);
  process.stdout.write("Embedded npm distribution verified\n");
}
