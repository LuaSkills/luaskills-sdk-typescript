import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import ts from "typescript";
import { generate, parseContract } from "../scripts/generate-embedded-contract.mjs";
import { embeddedContract, EmbeddedNativeStatus } from "../dist/index.js";

// Exact checked-in artifacts are the test inputs, independent of any native library.
// 精确已保存产物是测试输入，与任何原生库无关。
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Retain original bytes separately from the parsed document for digest verification.
// 将原始字节与解析文档分开保留，用于摘要校验。
const bytes = readFileSync(join(root, "contracts/embedded/v1/contract.json"));
// Each mutation test clones this authoritative document.
// 每个变更测试均复制此权威文档。
const contract = parseContract(bytes);

/**
 * Compile a temporary consumer against actual declarations and return readable diagnostics.
 * 编译针对实际声明的临时消费程序并返回可读诊断。
 * @param {string} source Consumer TypeScript source. 消费程序 TypeScript 源码。
 * @returns {string[]} All compilation diagnostics. 全部编译诊断。
 */
function compileConsumer(source) {
  const directory = mkdtempSync(join(tmpdir(), "luaskills-embedded-types-"));
  try {
    const file = join(directory, "consumer.mts");
    writeFileSync(file, source);
    const program = ts.createProgram([file], {
      strict: true, exactOptionalPropertyTypes: true, noEmit: true, skipLibCheck: false,
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
      types: [],
    });
    return ts.getPreEmitDiagnostics(program).map((item) => ts.flattenDiagnosticMessageText(item.messageText, "\n"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * Run the standalone generator with the current interpreter and require a specific result.
 * 使用当前解释器运行独立生成器，并要求特定结果。
 * @param {string} script Exact generator path. 精确生成器路径。
 * @param {string[]} args Explicit arguments. 显式参数。
 * @param {boolean} success Expected successful exit. 是否预期成功退出。
 * @returns {string} Combined diagnostics for negative assertions. 供失败断言使用的合并诊断。
 */
function runGenerator(script, args, success) {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
  assert.ifError(result.error);
  assert.equal(result.status === 0, success, result.stdout + result.stderr);
  return result.stdout + result.stderr;
}

test("exact bytes, metadata, commands and generated native statuses", () => {
  assert.equal(generate(contract, bytes), readFileSync(join(root, "src/embedded-contract.ts"), "utf8"));
  assert.equal(embeddedContract.EMBEDDED_CONTRACT_SHA256, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(readFileSync(join(root, "contracts/embedded/v1/contract.sha256"), "utf8"), `${embeddedContract.EMBEDDED_CONTRACT_SHA256}  contract.json\n`);
  assert.deepEqual(embeddedContract.EMBEDDED_ROOT_COMMANDS, contract.commands);
  assert.deepEqual(embeddedContract.EMBEDDED_RUNTIME_COMMANDS, contract.runtime_commands);
  for (const [name, value] of Object.entries(contract.native_status)) assert.equal(EmbeddedNativeStatus[name.toUpperCase()], value);
});

test("consumer types preserve bigint, optionality, explicit null and discriminated response maps", () => {
  const path = JSON.stringify(join(root, "dist/embedded-contract.js").replaceAll("\\", "/"));
  const source = `import type * as C from ${path};
/** Validate exact wide integers and nested JSON.
 * 验证精确大整数及嵌套 JSON。 */
const value: C.EmbeddedJsonValue = { boundary: 18446744073709551615n, negative: -9223372036854775808n, nil: null };
/** Input defaults remain optional.
 * 输入默认字段保持可省略。 */
const options: Pick<C.InputLuaRuntimeHostOptions, "runtime_root"> = {};
/** Discriminated commands match their real response map.
 * 判别命令匹配实际响应映射。 */
const reserve: C.InputCommand = { type: "runtime_reserve" };
/** Bind the response through a command name, preserving required identity.
 * 按命令名绑定响应，保留必需身份。 */
type Reserved = C.EmbeddedRootResponseMap[typeof reserve.type];
/** The result declaration includes the exact protocol envelope.
 * 结果声明包含精确协议信封。 */
const receipt: Reserved = { protocol_version: 1, status: "ok", result: { runtime_id: "rt-exact" } };
/** Required identity cannot be omitted.
 * 不可省略必需身份。 */
// @ts-expect-error Missing runtime identity.
// 缺少运行时身份。
const missing: C.InputCommand = { type: "runtime_status" };
/** Unknown commands cannot enter the typed surface.
 * 未知命令不能进入类型接口。
 */
// @ts-expect-error Unknown command.
// 未知命令。
const unknown: C.InputCommand = { type: "future_command" };
/** Explicit undefined is not a JSON value.
 * 显式 undefined 不是 JSON 值。 */
// @ts-expect-error Undefined loses wire evidence.
// undefined 会丢失线证据。
const absent: C.EmbeddedJsonValue = { missing: undefined };
void [value, options, reserve, receipt, missing, unknown, absent];
`;
  assert.deepEqual(compileConsumer(source), []);
});

test("independent roots cannot borrow missing definitions from other responses", () => {
  const changed = structuredClone(contract);
  const schema = changed.root_responses.runtime_status;
  assert.ok(Object.hasOwn(schema.$defs, "SuccessStatus"));
  delete schema.$defs.SuccessStatus;
  assert.throws(() => generate(changed, bytes), /independent root/);
});

test("unknown shape, incompatible definitions and generated-name collisions fail closed", () => {
  const unknown = structuredClone(contract);
  unknown.request.allOf = [];
  assert.throws(() => generate(unknown, bytes), /Unsupported schema keyword/);
  const conflict = structuredClone(contract);
  const containing = Object.values(conflict.root_responses).filter((schema) => Object.hasOwn(schema.$defs, "SuccessStatus"));
  assert.ok(containing.length > 1);
  containing[0].$defs.SuccessStatus.description = "Changed definition.\n已变更的定义。";
  assert.throws(() => generate(conflict, bytes), /Conflicting output definition/);
  const collision = structuredClone(contract);
  collision.request.$defs.Wire_Name = { type: "string" };
  collision.request.$defs.WireName = { type: "boolean" };
  assert.throws(() => generate(collision, bytes), /Generated name collision/);
});

test("command metadata cannot drift together away from actual request enum", () => {
  const changed = structuredClone(contract);
  changed.runtime_commands.push("future_command");
  changed.runtime_responses.future_command = structuredClone(changed.runtime_responses.operation_status);
  assert.throws(() => generate(changed, bytes), /Request enum coverage mismatch/);
  const missing = structuredClone(contract);
  delete missing.runtime_responses.operation_status;
  assert.throws(() => generate(missing, bytes), /Command response coverage mismatch/);
});

test("duplicate decoded keys, invalid UTF-8 and unsafe numbers retain failure evidence", () => {
  for (const source of ['{"same":1,"s\\u0061me":2}', '{"nested":[{"name":1,"name":2}]}']) {
    assert.throws(() => parseContract(Buffer.from(source)), /Duplicate contract member/);
  }
  assert.deepEqual(parseContract(Buffer.from('{"text":"a \\\"key\\\": 1","list":["x",{"other":true}]}')), { text: 'a "key": 1', list: ["x", { other: true }] });
  assert.throws(() => parseContract(Uint8Array.from([0xff])), TypeError);
  assert.throws(() => parseContract(Buffer.from('{"large":9007199254740993}')), /Unsafe contract metadata number/);
});

test("standalone copied generator checks read-only and rejects checksum changes", () => {
  const directory = mkdtempSync(join(tmpdir(), "luaskills-embedded-generator-"));
  try {
    for (const part of ["scripts", "src", "contracts/embedded/v1"]) mkdirSync(join(directory, part), { recursive: true });
    const script = join(directory, "scripts/generate-embedded-contract.mjs");
    copyFileSync(join(root, "scripts/generate-embedded-contract.mjs"), script);
    for (const name of ["contract.json", "contract.sha256", "README.md"]) copyFileSync(join(root, "contracts/embedded/v1", name), join(directory, "contracts/embedded/v1", name));
    runGenerator(script, [], true);
    runGenerator(script, ["--check"], true);
    const generated = join(directory, "src/embedded-contract.ts");
    const changed = readFileSync(generated, "utf8") + "\n// stale\n";
    writeFileSync(generated, changed);
    assert.match(runGenerator(script, ["--check"], false), /stale/);
    assert.equal(readFileSync(generated, "utf8"), changed);
    writeFileSync(join(directory, "contracts/embedded/v1/contract.sha256"), "0".repeat(64) + "  contract.json\n");
    assert.match(runGenerator(script, [], false), /SHA-256 mismatch/);
    assert.equal(readFileSync(generated, "utf8"), changed);
    assert.match(runGenerator(script, ["--check", "--source", "unused.json"], false), /cannot synchronize/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
