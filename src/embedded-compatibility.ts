import { EMBEDDED_CONTRACT_SHA256, EMBEDDED_CORE_VERSION, EMBEDDED_DESCRIPTION_MAX_BYTES, EMBEDDED_DESCRIPTION_VERSION, EMBEDDED_PROTOCOL_VERSION, EMBEDDED_REQUIRED_CAPABILITIES, EMBEDDED_ROOT_COMMANDS, EMBEDDED_RUNTIME_COMMANDS, type OutputCoreDescription, type OutputEmbeddedBuildIdentity, type OutputExecutionBackend } from "./embedded-contract.js";
import { decodeEmbeddedJson } from "./embedded-json.js";

/** Reject incompatible native metadata before creating or borrowing native ownership.
 * 在创建或借用原生所有权前拒绝不兼容的原生元数据。 */
export class EmbeddedCompatibilityError extends Error {
  /**
   * Retain a compatibility diagnostic and optional decoding cause without retrying native work.
   * 保留兼容诊断和可选解码原因，不重试原生工作。
   * @param message Explicit mismatch or malformed-description diagnostic.
   * 明确的不匹配或描述格式错误诊断。
   * @param options Optional original cause.
   * 可选原始原因。
   */
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = "EmbeddedCompatibilityError"; }
}

/** Require a JSON object for field; return its members or reject the native description.
 * 要求 field 为 JSON 对象；返回其成员或拒绝原生描述。 */
function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) throw new EmbeddedCompatibilityError(`Invalid native object: ${field}`);
  return value as Record<string, unknown>;
}

/** Require nonempty text for field; return its exact value without coercion.
 * 要求 field 为非空文本；返回未经强制转换的精确值。 */
function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new EmbeddedCompatibilityError(`Invalid native text: ${field}`);
  return value;
}

/** Require a lowercase SHA-256 for field; return the original validated digest.
 * 要求 field 为小写 SHA-256；返回已校验的原始摘要。 */
function digest(value: unknown, field: string): string {
  const hash = text(value, field);
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new EmbeddedCompatibilityError(`Invalid native digest: ${field}`);
  return hash;
}

/** Match a field against its generated scalar requirement; return that exact value or reject.
 * 将字段与生成标量要求匹配；返回该精确值或拒绝。 */
function exact<T extends string | number>(value: unknown, expected: T, field: string): T {
  if (value !== expected) throw new EmbeddedCompatibilityError(`Native ${field} mismatch; expected ${expected}`);
  return expected;
}

/** Validate unique nonempty names and required membership; return independent names in native order.
 * 校验唯一非空名称及必需成员；按原生顺序返回独立名称数组。 */
function names(value: unknown, required: readonly string[], field: string): string[] {
  if (!Array.isArray(value)) throw new EmbeddedCompatibilityError(`Invalid native array: ${field}`);
  const result = value.map((item: unknown) => text(item, field));
  const unique = new Set(result);
  if (unique.size !== result.length || required.some((name) => !unique.has(name))) throw new EmbeddedCompatibilityError(`Native ${field} does not meet the SDK contract`);
  return result;
}

/**
 * Decode bounded native bytes and check the exact generated contract plus the current process ABI.
 * 解码有界原生字节，并检查精确生成契约及当前进程 ABI。
 * @param bytes Independent copied metadata; no native pointer is retained or released here.
 * 独立复制的元数据；此处不保留或释放任何原生指针。
 * @param pointerBytes Actual pointer width reported by the loaded FFI implementation.
 * 已加载 FFI 实现报告的实际指针字节数。
 * @returns Independent typed metadata. Input hashes are provenance, not binary authentication.
 * 独立类型化元数据。输入摘要代表来源，不认证二进制。
 */
export function decodeCoreDescription(bytes: Uint8Array, pointerBytes: number): OutputCoreDescription {
  if (bytes.byteLength === 0 || bytes.byteLength > EMBEDDED_DESCRIPTION_MAX_BYTES) throw new EmbeddedCompatibilityError("Invalid native core description size");
  let parsed: unknown;
  try { parsed = decodeEmbeddedJson(bytes); }
  catch (cause) { throw new EmbeddedCompatibilityError("Invalid native core description JSON", { cause }); }
  const description = object(parsed, "description");
  const build = object(description.build, "build");
  // Enumerating the generated type makes a newly required build field a compile-time integration requirement.
  // 枚举生成类型，使新增必需构建字段成为编译时接入要求。
  const identity: OutputEmbeddedBuildIdentity = {
    inputs_sha256: digest(build.inputs_sha256, "inputs_sha256"),
    source_sha256: digest(build.source_sha256, "source_sha256"),
    contract_sha256: exact(build.contract_sha256, EMBEDDED_CONTRACT_SHA256, "contract_sha256"),
    package_lock_sha256: digest(build.package_lock_sha256, "package_lock_sha256"),
    rustflags_sha256: digest(build.rustflags_sha256, "rustflags_sha256"),
    target: text(build.target, "target"),
    target_os: text(build.target_os, "target_os"),
    target_arch: text(build.target_arch, "target_arch"),
    pointer_width: exact(build.pointer_width, String(pointerBytes * 8), "pointer_width"),
    opt_level: text(build.opt_level, "opt_level"),
    debug_info: text(build.debug_info, "debug_info"),
    rustc: text(build.rustc, "rustc"),
    cargo_features: names(build.cargo_features, [], "cargo_features"),
  };
  // Native loading enforces instruction-set compatibility; this check does not infer architecture from hardware.
  // 原生加载负责指令集兼容；此检查不从硬件推断进程架构。
  const operatingSystems: Readonly<Partial<Record<NodeJS.Platform, string>>> = { win32: "windows", linux: "linux", darwin: "macos" };
  const operatingSystem = operatingSystems[process.platform];
  if (operatingSystem === undefined || identity.target_os !== operatingSystem) throw new EmbeddedCompatibilityError("Native target operating system mismatch or unsupported process platform");
  const backends = names(description.execution_backends, ["in_process"], "execution_backends");
  const allowedBackends = { in_process: true, worker_process: true } satisfies Record<OutputExecutionBackend, boolean>;
  if (backends.some((backend) => !Object.hasOwn(allowedBackends, backend))) throw new EmbeddedCompatibilityError("Unknown native execution backend");
  return {
    description_version: exact(description.description_version, EMBEDDED_DESCRIPTION_VERSION, "description_version"),
    core_version: exact(description.core_version, EMBEDDED_CORE_VERSION, "core_version"),
    protocol_version: exact(description.protocol_version, EMBEDDED_PROTOCOL_VERSION, "protocol_version"),
    abi_structure_version: exact(description.abi_structure_version, EMBEDDED_PROTOCOL_VERSION, "abi_structure_version"),
    commands: names(description.commands, EMBEDDED_ROOT_COMMANDS, "commands"),
    runtime_commands: names(description.runtime_commands, EMBEDDED_RUNTIME_COMMANDS, "runtime_commands"),
    capabilities: names(description.capabilities, EMBEDDED_REQUIRED_CAPABILITIES, "capabilities"),
    execution_backends: backends as OutputExecutionBackend[],
    build: identity,
  };
}
