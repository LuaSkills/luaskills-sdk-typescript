import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { mkdtempSync, copyFileSync, rmSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { spawnSync } from "node:child_process";
import { MessageChannel } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import koffi from "koffi";
import { EmbeddedCompatibilityError, EmbeddedTransport, EmbeddedTransportError, EmbeddedCommandDriver, embeddedContract as contract } from "../dist/index.js";
import { decodeCoreDescription } from "../dist/embedded-compatibility.js";
import { serveEmbeddedWorker } from "../dist/embedded-worker-runtime.js";
import { budgets } from "./embedded-fixture.mjs";

// Real C ABI checks require an explicit matching development library.
// 实际 C ABI 检查要求显式匹配开发动态库。
const native = { skip: !process.env.LUASKILLS_LIB };

/** Return synthetic metadata with explicit generated identities for isolated boundary fault injection.
 * 返回带显式生成身份的合成元数据，用于隔离边界故障注入。 */
function description() {
  return {
    description_version: contract.EMBEDDED_DESCRIPTION_VERSION,
    core_version: contract.EMBEDDED_CORE_VERSION,
    protocol_version: contract.EMBEDDED_PROTOCOL_VERSION,
    abi_structure_version: contract.EMBEDDED_PROTOCOL_VERSION,
    commands: [...contract.EMBEDDED_ROOT_COMMANDS], runtime_commands: [...contract.EMBEDDED_RUNTIME_COMMANDS],
    capabilities: [...contract.EMBEDDED_REQUIRED_CAPABILITIES], execution_backends: ["in_process"],
    build: { inputs_sha256: "a".repeat(64), source_sha256: "b".repeat(64), contract_sha256: contract.EMBEDDED_CONTRACT_SHA256,
      package_lock_sha256: "c".repeat(64), rustflags_sha256: "d".repeat(64), target: "synthetic-test-target", target_arch: "synthetic-test-arch",
      target_os: { win32: "windows", linux: "linux", darwin: "macos" }[process.platform], pointer_width: String(koffi.sizeof("void *") * 8),
      opt_level: "0", debug_info: "true", rustc: "synthetic test compiler", cargo_features: [] },
  };
}

/** Invoke the production constructor with controlled FFI metadata; return observed allocation and copy counts.
 * 使用可控 FFI 元数据调用生产构造函数；返回观察到的分配及复制次数。 */
function boundary({ bytes = Buffer.from(JSON.stringify(description())), length = bytes.length, pointer = {}, status = 0, missing = false } = {}, assertion) {
  const counts = { created: 0, copied: 0, released: 0, bound: [] };
  const library = { func(name) {
    counts.bound.push(name);
    if (name === "luaskills_ffi_embedded_describe_v1") {
      if (missing) throw new Error("Missing symbol");
      return (output) => { output.ptr = pointer; output.len = length; return status; };
    }
    if (name === "luaskills_ffi_embedded_transport_new_v1") return (_config, output) => { counts.created += 1; output[0] = 99n; return 0; };
    if (name === "luaskills_ffi_embedded_result_free_v1") return () => { counts.released += 1; return 0; };
    if (name === "luaskills_ffi_embedded_transport_close_v1" || name === "luaskills_ffi_embedded_transport_free_v1") return () => 0;
    throw new Error(`Unexpected native request binding in fake library: ${name}`);
  } };
  mock.method(koffi, "load", () => library);
  mock.method(koffi, "address", () => 1n);
  mock.method(koffi, "decode", () => { counts.copied += 1; return bytes; });
  try { assertion(() => new EmbeddedTransport(budgets, { libraryPath: import.meta.filename }), counts); }
  finally { mock.restoreAll(); }
  return counts;
}

test("mismatched metadata fails before binding constructor or allocating native ownership", () => {
  for (const [field, value] of [
    ["description_version", 2], ["protocol_version", true], ["abi_structure_version", 2], ["core_version", "0.0.0"],
    ["commands", []], ["runtime_commands", []], ["capabilities", []], ["capabilities", ["same", "same"]],
    ["execution_backends", ["worker_process"]], ["execution_backends", ["in_process", "unknown"]],
  ]) {
    const invalid = description(); invalid[field] = value;
    const counts = boundary({ bytes: Buffer.from(JSON.stringify(invalid)) }, (create) => assert.throws(create, EmbeddedCompatibilityError));
    assert.equal(counts.created, 0, field); assert.equal(counts.released, 0, field);
    assert.deepEqual(counts.bound, ["luaskills_ffi_embedded_describe_v1"]);
  }
  for (const [field, value] of [["contract_sha256", "0".repeat(64)], ["inputs_sha256", "wrong"], ["target_os", "unsupported"], ["pointer_width", "0"], ["rustc", null], ["cargo_features", ["same", "same"]]]) {
    const invalid = description(); invalid.build[field] = value;
    const counts = boundary({ bytes: Buffer.from(JSON.stringify(invalid)) }, (create) => assert.throws(create, EmbeddedCompatibilityError));
    assert.equal(counts.created, 0, field); assert.equal(counts.released, 0, field);
  }
});

test("required metadata fields, strict JSON, and explicit float versions are rejected", () => {
  for (const group of [null, "build"]) {
    const original = description();
    for (const field of Object.keys(group === null ? original : original[group])) {
      const invalid = description(); delete (group === null ? invalid : invalid[group])[field];
      assert.throws(() => decodeCoreDescription(Buffer.from(JSON.stringify(invalid)), koffi.sizeof("void *")), EmbeddedCompatibilityError, `${group}.${field}`);
    }
  }
  for (const bytes of [Buffer.from([0xff]), Buffer.from("null"), Buffer.from("[]"), Buffer.from('{"core_version":1,"core_version":2}'), Buffer.from(JSON.stringify(description()).replace('"protocol_version":1,', '"protocol_version":1.0,'))]) {
    assert.throws(() => decodeCoreDescription(bytes, koffi.sizeof("void *")), EmbeddedCompatibilityError);
  }
});

test("missing bootstrap, native error, and invalid borrowed bounds prevent copying and ownership", () => {
  for (const options of [{ missing: true }, { status: contract.EmbeddedNativeStatus.INTERNAL }, { length: 0 }, { length: contract.EMBEDDED_DESCRIPTION_MAX_BYTES + 1 }, { length: -1 }, { length: 1.5 }, { pointer: null }]) {
    const counts = boundary(options, (create) => assert.throws(create, options.status ? EmbeddedTransportError : EmbeddedCompatibilityError));
    assert.equal(counts.created, 0); assert.equal(counts.copied, 0); assert.equal(counts.released, 0);
  }
});

test("additional capabilities survive independent snapshots and ordinary path assignment is rejected", native, () => {
  const transport = new EmbeddedTransport(budgets);
  try {
    const first = transport.coreDescription;
    assert.equal(first.build.contract_sha256, contract.EMBEDDED_CONTRACT_SHA256);
    assert.equal(first.core_version, transport.request({ type: "describe" }).core_version);
    const expected = transport.coreDescription;
    first.capabilities.length = 0; first.build.cargo_features.push("MUTATED");
    assert.deepEqual(transport.coreDescription, expected);
    assert.throws(() => { transport.libraryPath = "wrong"; }, TypeError);
    assert.throws(() => { transport.bindingIdentity = "wrong"; }, TypeError);
    const extended = description(); extended.capabilities.push("future_optional_capability");
    assert.deepEqual(decodeCoreDescription(Buffer.from(JSON.stringify(extended)), koffi.sizeof("void *")), extended);
  } finally { transport.close(); transport.free(); }
});

test("worker rejects different module identity before listeners, readiness, or native requests", () => {
  const { port1, port2 } = new MessageChannel();
  let requests = 0;
  try {
    assert.throws(() => serveEmbeddedWorker({ bindingIdentity: "a".repeat(64) }, port2, { bindingIdentity: "b".repeat(64), request() { requests += 1; } }), EmbeddedCompatibilityError);
    assert.equal(port2.listenerCount("message"), 0); assert.equal(requests, 0);
  } finally { port1.close(); port2.close(); }
});

test("worker compatibility error survives driver messaging and releases only after actual startup exit", native, async () => {
  const transport = new EmbeddedTransport(budgets);
  // Explicit test-only shadowing injects a wrong owner token while keeping the actual native transport intact.
  // 显式测试遮蔽注入错误所有者标识，同时保持实际原生传输完整。
  Object.defineProperty(transport, "bindingIdentity", { value: "0".repeat(64), configurable: true });
  const driver = new EmbeddedCommandDriver(transport, { workThreads: 1, maxWorkCommands: 1, maxControlCommands: 1 });
  try {
    await assert.rejects(driver.ready(), EmbeddedCompatibilityError);
    await driver.close();
    assert.equal(driver.status.closed, true);
    assert.equal(transport.request({ type: "describe" }).protocol_version, contract.EMBEDDED_PROTOCOL_VERSION);
  } finally { delete transport.bindingIdentity; await driver.close(); transport.close(); transport.free(); }
});

test("equal binary copies have different live module identities and cannot borrow each other's transports", native, () => {
  const directory = mkdtempSync(join(tmpdir(), "luaskills-module-identity-"));
  const copy = join(directory, basename(process.env.LUASKILLS_LIB));
  try {
    copyFileSync(process.env.LUASKILLS_LIB, copy);
    // The subprocess owns both module loads; its exit releases Windows file mappings before exact cleanup.
    // 子进程拥有两个模块加载；它退出后释放 Windows 文件映射，再精确清理。
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("./fixtures/embedded-compatibility-native.mjs", import.meta.url)), copy], { encoding: "utf8", timeout: 30000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr + result.stdout);
  } finally { rmSync(copy, { force: true }); rmdirSync(directory); }
});
