import { constants as bufferConstants } from "node:buffer";
import koffi from "koffi";
import { resolveLibraryPath } from "./ffi.js";
import { EMBEDDED_PROTOCOL_VERSION, EmbeddedNativeStatus, type EmbeddedInteger, type EmbeddedJsonValue, type InputCommand } from "./embedded-contract.js";
import { decodeEmbeddedJson, embeddedUnsignedInteger, encodeEmbeddedJson } from "./embedded-json.js";

/** Explicit transport budgets, including retained and currently executing ownership.
 * 显式传输预算，包含保留中及正在执行的所有权。 */
export interface EmbeddedTransportConfig {
  /** Maximum retained runtime registrations, including draining instances.
   * 最大保留运行时注册数量，包含正在排空的实例。 */
  readonly max_runtimes: EmbeddedInteger;
  /** Maximum results plus in-flight response reservations.
   * 结果加在途响应预留的最大数量。 */
  readonly max_result_buffers: EmbeddedInteger;
  /** Aggregate published bytes plus reserved worst-case response bytes.
   * 已发布字节加已预留最坏响应字节的聚合额度。 */
  readonly max_result_bytes: EmbeddedInteger;
  /** Maximum complete response, including its envelope.
   * 完整响应最大大小，包含信封。 */
  readonly max_response_bytes: EmbeddedInteger;
  /** Maximum complete UTF-8 request size.
   * 完整 UTF-8 请求最大大小。 */
  readonly max_request_bytes: EmbeddedInteger;
}

/** Exact native output descriptor; it is never passed to legacy buffer disposal.
 * 精确原生输出描述符；绝不传给旧版缓冲释放函数。 */
export interface NativeResult {
  /** Opaque native address, read only until matching release.
   * 不透明原生地址，匹配释放前只读。 */
  ptr: unknown;
  /** Exact native size_t length.
   * 精确原生 size_t 长度。 */
  len: number | bigint;
  /** Exact uint64 allocation identity.
   * 精确 uint64 分配身份。 */
  allocation_id: number | bigint;
}

// Anonymous layouts prevent collisions with other SDK copies or the legacy FFI module.
// 匿名布局避免与其他 SDK 副本或旧版 FFI 模块冲突。
const CONFIG_TYPE = koffi.struct({ struct_size: "uint32_t", protocol_version: "uint32_t", max_runtimes: "uint64_t", max_result_buffers: "uint64_t", max_result_bytes: "uint64_t", max_response_bytes: "uint64_t", max_request_bytes: "uint64_t" });
// The input view is borrowed only for the duration of the synchronous native call.
// 输入视图仅在同步原生调用期间借用。
const BORROWED_TYPE = koffi.struct({ ptr: "const void *", len: "size_t" });
// Native output widths and order come from FfiEmbeddedResultV1 in the public header.
// 原生输出位宽及顺序来自公开头文件中的 FfiEmbeddedResultV1。
const RESULT_TYPE = koffi.struct({ ptr: "const void *", len: "size_t", allocation_id: "uint64_t" });
// The platform's isize maximum is derived from its actual native pointer width.
// 平台 isize 最大值从实际原生指针位宽推导。
const ISIZE_MAX = (1n << BigInt(koffi.sizeof("size_t") * 8 - 1)) - 1n;
// Required budget fields are shared by validation and construction.
// 必需预算字段由校验和构造共用。
const CONFIG_FIELDS = Object.freeze(["max_runtimes", "max_result_buffers", "max_result_bytes", "max_response_bytes", "max_request_bytes"] as const);
// Unreleased native ownership must retain its library even when user references disappear.
// 即使用户引用消失，未释放的原生所有权也必须保留所属动态库。
const LIVE_TRANSPORTS = new Set<EmbeddedTransport>();

/** Shared exact ABI bindings used by the owner and its borrowed worker threads.
 * 所有者及其借用工作线程共用的精确 ABI 绑定。 */
export interface EmbeddedNativeBindings {
  /** Library reference retained until all native usage ends.
   * 保留到全部原生使用结束的动态库引用。 */
  readonly library: koffi.IKoffiLib;
  /** Allocate ownership from an exact native configuration.
   * 从精确原生配置分配所有权。 */
  readonly create: (config: object, output: Array<number | bigint>) => number;
  /** Request transport closure.
   * 请求传输关闭。 */
  readonly close: (identity: bigint) => number;
  /** Remove drained ownership.
   * 移除已排空所有权。 */
  readonly free: (identity: bigint) => number;
  /** Execute borrowed bytes and publish an exact result descriptor.
   * 执行借用字节并发布精确结果描述符。 */
  readonly request: (identity: bigint, input: { ptr: Buffer; len: number }, output: NativeResult) => number;
  /** Release one exact result belonging to identity.
   * 释放一个属于 identity 的精确结果。 */
  readonly resultFree: (identity: bigint, result: NativeResult) => number;
}

/**
 * Bind the complete ABI without allocating or assuming ownership of a transport.
 * 绑定完整 ABI，但不分配或假定传输所有权。
 * @param libraryPath Exact library path already selected by the owning transport.
 * 所属传输已经选定的精确动态库路径。
 * @returns Immutable bindings retaining the library reference.
 * 保留动态库引用的不可变绑定。
 */
export function bindEmbeddedNative(libraryPath: string): EmbeddedNativeBindings {
  const library = koffi.load(libraryPath);
  return Object.freeze({
    library,
    create: library.func("luaskills_ffi_embedded_transport_new_v1", "int32_t", [koffi.pointer(CONFIG_TYPE), koffi.out(koffi.pointer("uint64_t"))]),
    close: library.func("luaskills_ffi_embedded_transport_close_v1", "int32_t", ["uint64_t"]),
    free: library.func("luaskills_ffi_embedded_transport_free_v1", "int32_t", ["uint64_t"]),
    resultFree: library.func("luaskills_ffi_embedded_result_free_v1", "int32_t", ["uint64_t", RESULT_TYPE]),
    request: library.func("luaskills_ffi_embedded_request_v1", "int32_t", ["uint64_t", BORROWED_TYPE, koffi.out(koffi.pointer(RESULT_TYPE))]),
  });
}

/**
 * Execute a borrowed frame, copy its complete response and retain every failed native result release.
 * 执行借用帧、复制完整响应，并保留每个释放失败的原生结果。
 * @param identity Exact transport identity held alive by the caller.
 * 由调用方保活的精确传输身份。
 * @param encoded Immutable complete request bytes.
 * 不可变完整请求字节。
 * @param maxResponseBytes Declared maximum response bytes.
 * 声明的响应字节上限。
 * @param owners Exact descriptors still owned by this execution context.
 * 此执行上下文仍拥有的精确描述符。
 * @param request Bound native request function.
 * 已绑定原生请求函数。
 * @param resultFree Bound native result release function.
 * 已绑定原生结果释放函数。
 * @returns Independently owned response bytes; errors never authorize business replay.
 * 独立拥有的响应字节；错误绝不授权业务重放。
 */
export function requestEmbeddedNative(identity: bigint, encoded: Buffer, maxResponseBytes: bigint, owners: Map<bigint, Readonly<NativeResult>>, request: EmbeddedNativeBindings["request"], resultFree: EmbeddedNativeBindings["resultFree"]): Buffer {
  const result: NativeResult = { ptr: null, len: 0n, allocation_id: 0n };
  let responseBytes: Buffer | null = null;
  try {
    const status = request(identity, { ptr: encoded, len: encoded.length }, result);
    if (status !== EmbeddedNativeStatus.OK) throw new EmbeddedTransportError("luaskills_ffi_embedded_request_v1", status);
    const length = embeddedUnsignedInteger(result.len, "result length");
    if (!result.ptr || result.allocation_id === 0 || result.allocation_id === 0n || length === 0n || length > maxResponseBytes || length > BigInt(bufferConstants.MAX_LENGTH)) throw new Error("Invalid embedded result descriptor");
    // Copy through Uint8Array; Buffer.from(ArrayBuffer) alone would alias the native allocation.
    // 经 Uint8Array 复制；仅使用 Buffer.from(ArrayBuffer) 会别名原生分配。
    responseBytes = Buffer.from(new Uint8Array(koffi.view(result.ptr, Number(length))));
    return responseBytes;
  } finally {
    if (result.allocation_id !== 0 && result.allocation_id !== 0n) {
      const allocation = embeddedUnsignedInteger(result.allocation_id, "allocation_id");
      const owned = Object.freeze({ ...result });
      owners.set(allocation, owned);
      let status: number;
      try { status = resultFree(identity, owned); }
      catch (cause) { throw new EmbeddedResultReleaseError(null, responseBytes, cause); }
      if (status !== EmbeddedNativeStatus.OK) throw new EmbeddedResultReleaseError(status, responseBytes);
      owners.delete(allocation);
    }
  }
}

/** Native ABI rejection, separate from a delivered structured business error.
 * 原生 ABI 拒绝，独立于已交付的结构化业务错误。 */
export class EmbeddedTransportError extends Error {
  /**
   * Retain the exact entrypoint and signed native status; never infer mutation replay safety.
   * 保留精确入口及有符号原生状态；绝不推断业务重放安全性。
   * @param functionName Exact C entrypoint.
   * 精确 C 入口。
   * @param status Actual native status, or null if the binding returned no status.
   * 实际原生状态；绑定未返回状态时为 null。
   */
  constructor(readonly functionName: string, readonly status: number | null) {
    super(status === null ? `${functionName} did not return a native status` : `${functionName} failed with native status ${status}`);
    this.name = "EmbeddedTransportError";
  }
}

/** Delivered core business error, whose code is consumed without parsing its English message.
 * 已交付核心业务错误；使用错误码，无需解析英文消息。 */
export class EmbeddedRuntimeError extends Error {
  /**
   * Construct a business error from exact delivered code and message.
   * 从精确交付的错误码及消息构造业务错误。
   * @param code Stable core classification.
   * 稳定核心分类。
   * @param message Core diagnostic text.
   * 核心诊断文字。
   */
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "EmbeddedRuntimeError";
  }
}

/** Retained response-release failure with an independently owned copy of delivery evidence.
 * 保留的响应释放失败，携带独立拥有的交付证据副本。 */
export class EmbeddedResultReleaseError extends EmbeddedTransportError {
  // Private bytes cannot be overwritten through a caller-held Buffer alias.
  // 私有字节不能经调用方持有的 Buffer 别名覆盖。
  readonly #bytes: Buffer | null;

  /**
   * Preserve response bytes after the matching native release fails.
   * 匹配原生释放失败后保留响应字节。
   * @param status Exact result-free status, or null for a thrown binding error.
   * 精确结果释放状态；绑定抛出异常时为 null。
   * @param responseBytes Copied response or null when copying did not finish.
   * 已复制响应；复制未完成时为 null。
   * @param cause Original binding exception, if one was thrown.
   * 如有抛出则为原始绑定异常。
   */
  constructor(status: number | null, responseBytes: Buffer | null, cause?: unknown) {
    super("luaskills_ffi_embedded_result_free_v1", status);
    this.name = "EmbeddedResultReleaseError";
    this.#bytes = responseBytes === null ? null : Buffer.from(responseBytes);
    if (cause !== undefined) this.cause = cause;
  }

  /** Return a fresh evidence copy, never the retained mutable Buffer itself.
   * 返回新的证据副本，绝不返回保留的可变 Buffer 本身。 */
  get responseBytes(): Buffer | null { return this.#bytes === null ? null : Buffer.from(this.#bytes); }

  /** Decode the original delivered result without another C call; throw if evidence is absent or invalid.
   * 不再次调用 C 而解码原有交付结果；证据缺失或无效时抛错。 */
  deliveredResult(): EmbeddedJsonValue {
    if (this.#bytes === null) throw new Error("No copied embedded response is available");
    return decodeEmbeddedResponse(this.#bytes);
  }
}

/**
 * Decode the one supported envelope version and preserve result absence separately from null.
 * 解码唯一支持的信封版本，并将结果缺失与空值分开。
 * @param bytes Owned complete response.
 * 拥有的完整响应。
 * @returns Delivered result; throws native-independent business or format errors.
 * 已交付结果；抛出独立于原生状态的业务或格式错误。
 */
export function decodeEmbeddedResponse(bytes: Uint8Array): EmbeddedJsonValue {
  const envelope = decodeEmbeddedJson(bytes);
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope) || !("protocol_version" in envelope) || envelope.protocol_version !== EMBEDDED_PROTOCOL_VERSION) throw new TypeError("Invalid embedded response protocol version");
  const fields = Object.keys(envelope).sort().join(",");
  if (fields === "protocol_version,result,status" && "status" in envelope && envelope.status === "ok" && "result" in envelope) return envelope.result;
  if (fields === "error,protocol_version,status" && "status" in envelope && envelope.status === "error" && "error" in envelope) {
    const error = envelope.error;
    if (error && typeof error === "object" && !Array.isArray(error) && Object.keys(error).sort().join(",") === "code,message" && "code" in error && "message" in error && typeof error.code === "string" && typeof error.message === "string") throw new EmbeddedRuntimeError(error.code, error.message);
  }
  throw new TypeError("Invalid embedded response envelope");
}

/**
 * Synchronous low-level owner of one formal transport; asynchronous hosts must drive it off their event loop.
 * 一个正式传输的同步底层所有者；异步宿主必须在事件循环之外驱动它。
 */
export class EmbeddedTransport {
  /** Resolved authoritative library path, retained for diagnostics.
   * 已解析的权威动态库路径，保留用于诊断。 */
  readonly libraryPath: string;
  // Actual dynamic library owner and exact ABI bindings remain strongly reachable until native release.
  // 实际动态库所有者及精确 ABI 绑定保持强可达，直到原生释放。
  private readonly library: koffi.IKoffiLib;
  // Allocates one independent native transport after all symbols have been bound.
  // 在绑定全部符号后分配一个独立原生传输。
  private readonly nativeNew: (config: object, output: Array<number | bigint>) => number;
  // Requests admission closure while retaining the native owner.
  // 请求关闭入场，同时保留原生所有者。
  private readonly nativeClose: (identity: bigint) => number;
  // Removes a drained native transport without unloading other owners.
  // 移除已排空原生传输，不卸载其他所有者。
  private readonly nativeFree: (identity: bigint) => number;
  // Executes one borrowed input and publishes one independent result descriptor.
  // 执行一个借用输入并发布一个独立结果描述符。
  private readonly nativeRequest: (identity: bigint, input: { ptr: Buffer; len: number }, output: NativeResult) => number;
  // Releases only the exact descriptor belonging to the same transport.
  // 仅释放属于同一传输的精确描述符。
  private readonly nativeResultFree: (identity: bigint, output: NativeResult) => number;
  // Immutable normalized budgets preserve all bits and prevent post-construction configuration drift.
  // 不可变规范化预算保留全部位，防止构造后的配置漂移。
  private readonly budgets: Readonly<Record<keyof EmbeddedTransportConfig, bigint>>;
  // Identity disappears only after successful native transport removal.
  // 仅在原生传输成功移除后清除身份。
  private identity: bigint | null = null;
  // Calls include buffer readers and release code, not only the native request stack.
  // 调用包含缓冲读取者及释放代码，不仅是原生请求栈。
  private activeCalls = 0;
  // Failed releases retain the exact native descriptor until explicit recovery succeeds.
  // 释放失败保留精确原生描述符，直到显式恢复成功。
  private readonly results = new Map<bigint, Readonly<NativeResult>>();
  // A driver claim spans startup, queued work, retained results and actual worker exits.
  // 驱动声明覆盖启动、排队工作、保留结果及实际工作线程退出。
  private commandDriver: object | null = null;

  /**
   * Bind all five exports before allocating ownership with explicit validated budgets.
   * 在以显式已校验预算分配所有权前绑定全部五个导出。
   * @param config Exact positive transport limits.
   * 精确正数传输限制。
   * @param options Existing SDK library selection, with no protocol fallback.
   * 既有 SDK 动态库选择，不进行协议回退。
   */
  constructor(config: EmbeddedTransportConfig, options: { libraryPath?: string; runtimeRoot?: string } = {}) {
    // Inspect data descriptors first so invalid getters or numeric conversions cannot execute during C setup.
    // 先检查数据描述符，避免无效 getter 或数值转换在 C 设置期间执行。
    const descriptors = Object.getOwnPropertyDescriptors(config);
    if (Reflect.ownKeys(descriptors).length !== CONFIG_FIELDS.length || CONFIG_FIELDS.some((key) => !Object.hasOwn(descriptors, key) || !("value" in descriptors[key]))) throw new TypeError("Embedded transport requires exactly five data budgets");
    const normalized = {} as Record<keyof EmbeddedTransportConfig, bigint>;
    for (const key of CONFIG_FIELDS) {
      const value = embeddedUnsignedInteger(descriptors[key].value, key);
      if (value === 0n || value > ISIZE_MAX) throw new RangeError(`${key} must be positive and within native isize`);
      normalized[key] = value;
    }
    if (normalized.max_response_bytes > normalized.max_result_bytes) throw new RangeError("max_response_bytes exceeds max_result_bytes");
    this.budgets = Object.freeze(normalized);
    this.libraryPath = resolveLibraryPath(options.libraryPath, options.runtimeRoot);
    const native = bindEmbeddedNative(this.libraryPath);
    this.library = native.library;
    this.nativeNew = native.create;
    this.nativeClose = native.close;
    this.nativeFree = native.free;
    this.nativeResultFree = native.resultFree;
    this.nativeRequest = native.request;
    const output: Array<number | bigint> = [0n];
    LIVE_TRANSPORTS.add(this);
    // A thrown binding error may follow publication; retain the library unless native rejection proves no owner.
    // 绑定异常可能发生在发布之后；除非原生拒绝证明没有所有者，否则保留动态库。
    const status = this.nativeNew({ struct_size: koffi.sizeof(CONFIG_TYPE), protocol_version: EMBEDDED_PROTOCOL_VERSION, ...this.budgets }, output);
    if (status !== EmbeddedNativeStatus.OK) { LIVE_TRANSPORTS.delete(this); this.check("luaskills_ffi_embedded_transport_new_v1", status); }
    const published = embeddedUnsignedInteger(output[0], "transport_id");
    if (published === 0n) throw new Error("Native transport returned a zero identity");
    this.identity = published;
  }

  /** Return a frozen snapshot of retained owners, including failed construction with uncertain publication.
   * 返回保留所有者的冻结快照，包含构造失败且发布结果不确定的实例。 */
  static get live(): readonly EmbeddedTransport[] { return Object.freeze([...LIVE_TRANSPORTS]); }

  /** Return immutable normalized bigint budgets.
   * 返回不可变的规范化 bigint 预算。 */
  get config(): Readonly<Record<keyof EmbeddedTransportConfig, bigint>> { return this.budgets; }

  /** Return exact identity or null after release or unconfirmed construction.
   * 返回精确身份；释放后或构造未确认时为 null。 */
  get transportId(): bigint | null { return this.identity; }

  /** Return the count of results still requiring explicit native release.
   * 返回仍需显式原生释放的结果数量。 */
  get retainedResults(): number { return this.results.size; }

  /**
   * Freeze and execute one exact versioned command, copying bytes before releasing its native result.
   * 冻结并执行一个精确版本化命令，在释放原生结果前复制字节。
   * @param command Generated input command, also validated by the actual core.
   * 生成输入命令，同时由实际核心校验。
   * @returns Delivered business result; failed release preserves delivery evidence.
   * 已交付业务结果；释放失败保留交付证据。
   */
  request(command: InputCommand): EmbeddedJsonValue {
    const encoded = encodeEmbeddedJson({ protocol_version: EMBEDDED_PROTOCOL_VERSION, command }, this.budgets.max_request_bytes);
    const identity = this.requireIdentity();
    this.activeCalls += 1;
    try {
      const response = requestEmbeddedNative(identity, encoded, this.budgets.max_response_bytes, this.results, this.nativeRequest, this.nativeResultFree);
      return decodeEmbeddedResponse(response);
    } finally {
      this.activeCalls -= 1;
    }
  }

  /** Request permanent native admission closure; keep existing runtime cleanup and diagnostics available.
   * 请求永久关闭原生入场；保留现有运行时清理和诊断能力。 */
  close(): void {
    const identity = this.requireIdentity();
    this.activeCalls += 1;
    try { this.check("luaskills_ffi_embedded_transport_close_v1", this.nativeClose(identity)); }
    finally { this.activeCalls -= 1; }
  }

  /** Retry exact retained result releases only; reject while any reader or native call is active.
   * 仅重试精确保留结果的释放；任何读取者或原生调用活动时拒绝。 */
  releaseResults(): void {
    const identity = this.requireIdentity();
    if (this.activeCalls) throw new Error("Embedded transport still has active calls");
    this.activeCalls += 1;
    try {
      for (const [allocation, result] of this.results) {
        this.check("luaskills_ffi_embedded_result_free_v1", this.nativeResultFree(identity, result));
        this.results.delete(allocation);
      }
    } finally { this.activeCalls -= 1; }
  }

  /** Remove native ownership after actual runtime drainage; rejection leaves the transport usable for cleanup.
   * 实际运行时排空后移除原生所有权；拒绝后传输仍可用于清理。 */
  free(): void {
    const identity = this.requireIdentity();
    if (this.activeCalls || this.results.size || this.commandDriver !== null) throw new Error("Embedded transport still owns active calls or results or a command driver");
    this.activeCalls += 1;
    try {
      this.check("luaskills_ffi_embedded_transport_free_v1", this.nativeFree(identity));
      this.identity = null;
      LIVE_TRANSPORTS.delete(this);
    } finally { this.activeCalls -= 1; }
  }

  /** Return confirmed exact ownership, rejecting access after free or uncertain construction.
   * 返回已确认精确所有权；释放后或构造不确定时拒绝访问。 */
  private requireIdentity(): bigint {
    if (this.identity === null) throw new Error("Embedded transport has no confirmed live identity");
    return this.identity;
  }

  /**
   * Raise an exact native error without classifying business delivery or retry safety.
   * 抛出精确原生错误，不推断业务交付或重试安全性。
   * @param functionName Actual C entrypoint.
   * 实际 C 入口。
   * @param status Returned native status.
   * 返回的原生状态。
   */
  private check(functionName: string, status: number): void {
    if (status !== EmbeddedNativeStatus.OK) throw new EmbeddedTransportError(functionName, status);
  }

  /**
   * Claim one driver after verifying concurrent frame headroom; raw callers still share native budgets.
   * 核对并发帧容量后声明一个驱动；直接调用方仍共享原生预算。
   * @param owner Exact local driver object.
   * 精确本地驱动对象。
   * @param slots Work workers plus independently reserved control workers.
   * 业务工作线程加独立预留控制工作线程。
   * @returns Exact identity borrowed until releaseDriver succeeds.
   * 借用到 releaseDriver 成功为止的精确身份。
   * @internal
   */
  claimDriver(owner: object, slots: number): bigint {
    const identity = this.requireIdentity();
    if (this.commandDriver !== null) throw new Error("Embedded transport already has a command driver");
    if (!Number.isSafeInteger(slots) || slots <= 0 || BigInt(slots) > this.budgets.max_result_buffers || BigInt(slots) * this.budgets.max_response_bytes > this.budgets.max_result_bytes) throw new RangeError("Native transport cannot reserve the driver's concurrent response frames");
    this.commandDriver = owner;
    return identity;
  }

  /**
   * Return the exact driver claim only after its coordinator proves every worker has exited safely.
   * 仅在协调器证明每个工作线程安全退出后归还精确驱动声明。
   * @param owner Original local owner; mismatches are rejected.
   * 原始本地所有者；不匹配时拒绝。
   * @internal
   */
  releaseDriver(owner: object): void {
    if (this.commandDriver !== owner) throw new Error("Embedded command driver ownership mismatch");
    this.commandDriver = null;
  }
}
