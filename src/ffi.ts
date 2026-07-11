import koffi from "koffi";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { resolveLuaSkillsLibraryPathFromRuntime } from "./runtime-assets.js";
import type { FfiDescribeResult, JsonValue, LuaSkillsSdkOptions, SkillInstallSourceType } from "./types.js";

/**
 * Owned buffer shape returned by the LuaSkills JSON FFI.
 * LuaSkills JSON FFI 返回的拥有型缓冲结构。
 */
interface FfiOwnedBuffer {
  /**
   * Native pointer exposed by koffi as an opaque pointer value.
   * koffi 以不透明指针值形式暴露的原生指针。
   */
  ptr: unknown | null;
  /**
   * Byte length of the pointed buffer.
   * 指针缓冲区的字节长度。
   */
  len: number | bigint;
}

/**
 * Borrowed buffer shape passed into the LuaSkills JSON FFI.
 * 传入 LuaSkills JSON FFI 的借用型缓冲结构。
 */
interface FfiBorrowedBuffer {
  /**
   * Native pointer backed by a live Node Buffer.
   * 由存活 Node Buffer 支撑的原生指针。
   */
  ptr: Buffer | null;
  /**
   * Byte length of the borrowed payload.
   * 借用载荷的字节长度。
   */
  len: number;
}

/**
 * Standard JSON response envelope produced by the Rust FFI layer.
 * Rust FFI 层生成的标准 JSON 响应包络。
 */
interface FfiJsonEnvelope<T> {
  /**
   * Whether the FFI call succeeded.
   * FFI 调用是否成功。
   */
  ok: boolean;
  /**
   * Successful result payload.
   * 成功结果载荷。
   */
  result?: T;
  /**
   * Error message returned by the runtime.
   * 运行时返回的错误消息。
   */
  error?: string;
}

/**
 * Function shape used by JSON FFI entrypoints that accept one borrowed JSON buffer.
 * 接收单个借用 JSON 缓冲的 JSON FFI 入口函数形状。
 */
type JsonInputFunction = (input: FfiBorrowedBuffer) => FfiOwnedBuffer;

/**
 * Function shape used by JSON FFI entrypoints that do not need input.
 * 不需要输入的 JSON FFI 入口函数形状。
 */
type JsonNoInputFunction = () => FfiOwnedBuffer;

/**
 * Shared host-side JSON callback shape implemented by SDK callers.
 * 由 SDK 调用方实现的共享宿主侧 JSON callback 形状。
 */
type JsonCallback<Request extends JsonValue = JsonValue> = (request: Request) => JsonValue;

/**
 * Host-side JSON provider callback implemented by SDK callers.
 * 由 SDK 调用方实现的宿主侧 JSON provider callback。
 */
export type JsonProviderCallback = JsonCallback;

/** Host callback scheduled when managed-session events become readable. / 受管会话事件变为可读时调度的宿主回调。 */
export type ManagedSessionWakeCallback = (engineId: number) => void;

/**
 * Host-tool bridge action names emitted by `vulcan.host.*`.
 * `vulcan.host.*` 发出的宿主工具桥接动作名称。
 */
export type HostToolJsonAction = "list" | "has" | "call";

/**
 * Host-tool bridge request delivered to the SDK callback.
 * 传递给 SDK callback 的宿主工具桥接请求。
 */
export type HostToolJsonRequest = {
  /**
   * Future-compatible JSON fields emitted by the native bridge.
   * 原生桥未来可能发出的前向兼容 JSON 字段。
   */
  [key: string]: JsonValue | undefined;
  /**
   * Requested host-tool bridge action.
   * 请求的宿主工具桥接动作。
   */
  action: HostToolJsonAction;
  /**
   * Optional host tool name for `has` and `call` actions.
   * `has` 与 `call` 动作使用的可选宿主工具名称。
   */
  tool_name?: string | null;
  /**
   * JSON payload converted from the Lua table argument.
   * 从 Lua table 参数转换得到的 JSON 载荷。
   */
  args: JsonValue;
};

/**
 * Host-side tool bridge JSON callback implemented by SDK callers.
 * 由 SDK 调用方实现的宿主工具桥接 JSON callback。
 */
export type HostToolJsonCallback = JsonCallback<HostToolJsonRequest>;

/**
 * Skill operation progress plane names emitted by Rust progress events.
 * Rust 进度事件发出的 skill 操作平面名称。
 */
export type SkillOperationProgressPlane = "Skills" | "System";

/**
 * Skill operation progress action names emitted by Rust progress events.
 * Rust 进度事件发出的 skill 操作动作名称。
 */
export type SkillOperationProgressAction = "Install" | "Update" | "Reload" | "Uninstall" | "Enable" | "Disable";

/**
 * Skill lifecycle progress event delivered to the SDK callback.
 * 传递给 SDK callback 的 skill 生命周期进度事件。
 */
export interface SkillOperationProgressEvent {
  /**
   * Future-compatible JSON fields emitted by the native bridge.
   * 原生桥未来可能发出的当前未知 JSON 字段。
   */
  [key: string]: JsonValue | undefined;
  /**
   * Stable operation id shared by all events from one lifecycle operation.
   * 同一个生命周期操作全部事件共享的稳定操作标识。
   */
  operation_id: string;
  /**
   * Monotonic sequence number inside the current operation.
   * 当前操作内的单调递增序号。
   */
  sequence: number;
  /**
   * Operation plane that owns the lifecycle operation.
   * 拥有该生命周期操作的操作平面。
   */
  plane: SkillOperationProgressPlane;
  /**
   * Lifecycle action represented by the event.
   * 该事件表示的生命周期动作。
   */
  action: SkillOperationProgressAction;
  /**
   * Machine-readable phase name.
   * 机器可读的阶段名称。
   */
  phase: string;
  /**
   * Machine-readable phase status.
   * 机器可读的阶段状态。
   */
  status: string;
  /**
   * Optional target skill id.
   * 可选目标 skill 标识。
   */
  skill_id?: string | null;
  /**
   * Optional target root name.
   * 可选目标 root 名称。
   */
  root_name?: string | null;
  /**
   * Optional source type involved in the current phase.
   * 当前阶段涉及的可选来源类型。
   */
  source_type?: SkillInstallSourceType | `${SkillInstallSourceType}` | null;
  /**
   * Optional source locator involved in the current phase.
   * 当前阶段涉及的可选来源定位值。
   */
  source_locator?: string | null;
  /**
   * Optional completed byte count for download phases.
   * 下载阶段的可选已完成字节数。
   */
  bytes_done?: number | null;
  /**
   * Optional total byte count for download phases.
   * 下载阶段的可选总字节数。
   */
  bytes_total?: number | null;
  /**
   * Optional determinate progress percentage.
   * 可选的确定性进度百分比。
   */
  percent?: number | null;
  /**
   * Optional human-readable progress message.
   * 可选的人类可读进度消息。
   */
  message?: string | null;
}

/**
 * Host-side skill operation progress callback implemented by SDK callers.
 * 由 SDK 调用方实现的宿主侧 skill 操作进度 callback。
 */
export type SkillOperationProgressCallback = JsonCallback<SkillOperationProgressEvent>;

/**
 * Standard model capability names exposed by vulcan.models.*.
 * vulcan.models.* 暴露的标准模型能力名称。
 */
export type RuntimeModelCapability = "embed" | "llm";

/**
 * Caller context attached by LuaSkills to each model callback request.
 * LuaSkills 附加到每个模型 callback 请求上的调用方上下文。
 */
export type RuntimeModelCaller = {
  /**
   * Future-compatible JSON fields emitted by the native bridge.
   * 原生桥未来可能发出的前向兼容 JSON 字段。
   */
  [key: string]: JsonValue | undefined;
  /**
   * Skill identifier that owns the active Lua entry.
   * 拥有当前 Lua 入口的 skill 标识符。
   */
  skill_id?: string | null;
  /**
   * Local entry name declared by the owning skill.
   * 所属 skill 声明的局部入口名称。
   */
  entry_name?: string | null;
  /**
   * Canonical runtime tool name currently executing.
   * 当前正在执行的 canonical 运行时工具名称。
   */
  canonical_tool_name?: string | null;
  /**
   * Runtime root name that owns the current skill.
   * 拥有当前 skill 的运行时根名称。
   */
  root_name?: string | null;
  /**
   * Host-visible absolute skill directory.
   * 对宿主可见的绝对 skill 目录。
   */
  skill_dir?: string | null;
  /**
   * Host-provided client name from the current request context.
   * 当前请求上下文中的宿主提供客户端名称。
   */
  client_name?: string | null;
  /**
   * Host-provided request identifier from the current request context.
   * 当前请求上下文中的宿主提供请求标识符。
   */
  request_id?: string | null;
};

/**
 * Optional token usage metadata returned by host-managed model providers.
 * 宿主管理模型 provider 返回的可选 token 用量元数据。
 */
export type RuntimeModelUsage = {
  /**
   * Future-compatible JSON fields emitted by the native bridge.
   * 原生桥未来可能发出的前向兼容 JSON 字段。
   */
  [key: string]: JsonValue | undefined;
  /**
   * Optional input token count.
   * 可选输入 token 数量。
   */
  input_tokens?: number | null;
  /**
   * Optional output token count.
   * 可选输出 token 数量。
   */
  output_tokens?: number | null;
};

/**
 * Embedding request delivered to the SDK callback.
 * 传递给 SDK callback 的 embedding 请求。
 */
export type RuntimeModelEmbedRequest = {
  /**
   * Future-compatible JSON fields emitted by the native bridge.
   * 原生桥未来可能发出的前向兼容 JSON 字段。
   */
  [key: string]: JsonValue | undefined;
  /**
   * Single input text requested by Lua.
   * Lua 请求的单条输入文本。
   */
  text: string;
  /**
   * Caller context captured from the active Lua runtime scope.
   * 从当前 Lua 运行时作用域捕获的调用方上下文。
   */
  caller: RuntimeModelCaller;
};

/**
 * Embedding response returned by the SDK callback.
 * SDK callback 返回的 embedding 响应。
 */
export type RuntimeModelEmbedResponse = {
  /**
   * Future-compatible JSON fields emitted by the native bridge.
   * 原生桥未来可能发出的前向兼容 JSON 字段。
   */
  [key: string]: JsonValue | undefined;
  /**
   * Embedding vector returned by the host-managed model provider.
   * 宿主管理模型 provider 返回的 embedding 向量。
   */
  vector: number[];
  /**
   * Number of vector dimensions reported by the host.
   * 宿主报告的向量维度数量。
   */
  dimensions: number;
  /**
   * Optional token usage metadata reported by the host.
   * 宿主报告的可选 token 用量元数据。
   */
  usage?: RuntimeModelUsage | null;
};

/**
 * Non-streaming LLM request delivered to the SDK callback.
 * 传递给 SDK callback 的非流式 LLM 请求。
 */
export type RuntimeModelLlmRequest = {
  /**
   * Future-compatible JSON fields emitted by the native bridge.
   * 原生桥未来可能发出的前向兼容 JSON 字段。
   */
  [key: string]: JsonValue | undefined;
  /**
   * System instruction text supplied by Lua.
   * Lua 提供的 system 指令文本。
   */
  system: string;
  /**
   * User message text supplied by Lua.
   * Lua 提供的 user 消息文本。
   */
  user: string;
  /**
   * Caller context captured from the active Lua runtime scope.
   * 从当前 Lua 运行时作用域捕获的调用方上下文。
   */
  caller: RuntimeModelCaller;
};

/**
 * Non-streaming LLM response returned by the SDK callback.
 * SDK callback 返回的非流式 LLM 响应。
 */
export type RuntimeModelLlmResponse = {
  /**
   * Future-compatible JSON fields emitted by the native bridge.
   * 原生桥未来可能发出的前向兼容 JSON 字段。
   */
  [key: string]: JsonValue | undefined;
  /**
   * Assistant text returned by the host-managed model provider.
   * 宿主管理模型 provider 返回的 assistant 文本。
   */
  assistant: string;
  /**
   * Optional token usage metadata reported by the host.
   * 宿主报告的可选 token 用量元数据。
   */
  usage?: RuntimeModelUsage | null;
};

/**
 * Stable model error codes accepted by the JSON callback bridge.
 * JSON callback 桥接受的稳定模型错误码。
 */
export type RuntimeModelErrorCode =
  | "model_unavailable"
  | "invalid_argument"
  | "provider_error"
  | "timeout"
  | "budget_exceeded"
  | "internal_error";

/**
 * Structured model error returned by a model JSON callback.
 * 模型 JSON callback 返回的结构化模型错误。
 */
export type RuntimeModelError = {
  /**
   * Future-compatible JSON fields emitted by the native bridge.
   * 原生桥未来可能发出的前向兼容 JSON 字段。
   */
  [key: string]: JsonValue | undefined;
  /**
   * Stable LuaSkills-level model error code.
   * 稳定的 LuaSkills 级模型错误码。
   */
  code: RuntimeModelErrorCode;
  /**
   * Human-readable error summary.
   * 人类可读的错误摘要。
   */
  message: string;
  /**
   * Optional raw provider error text after host-side redaction.
   * 宿主侧脱敏后的可选 provider 原始错误文本。
   */
  provider_message?: string | null;
  /**
   * Optional raw provider error code.
   * 可选 provider 原始错误码。
   */
  provider_code?: string | null;
  /**
   * Optional provider status such as an HTTP status code.
   * 可选 provider 状态，例如 HTTP 状态码。
   */
  provider_status?: number | null;
};

/**
 * Error envelope returned by a model JSON callback.
 * 模型 JSON callback 返回的错误包络。
 */
export type RuntimeModelErrorEnvelope = {
  /**
   * Future-compatible JSON fields emitted by the native bridge.
   * 原生桥未来可能发出的前向兼容 JSON 字段。
   */
  [key: string]: JsonValue | undefined;
  /**
   * Always false for callback error envelopes.
   * callback 错误包络中固定为 false。
   */
  ok: false;
  /**
   * Structured model error payload.
   * 结构化模型错误载荷。
   */
  error: RuntimeModelError;
};

/**
 * Host-side model embedding JSON callback implemented by SDK callers.
 * 由 SDK 调用方实现的宿主侧模型 embedding JSON callback。
 */
export type ModelEmbedJsonCallback = (
  request: RuntimeModelEmbedRequest,
) => RuntimeModelEmbedResponse | RuntimeModelErrorEnvelope;

/**
 * Host-side model LLM JSON callback implemented by SDK callers.
 * 由 SDK 调用方实现的宿主侧模型 LLM JSON callback。
 */
export type ModelLlmJsonCallback = (
  request: RuntimeModelLlmRequest,
) => RuntimeModelLlmResponse | RuntimeModelErrorEnvelope;

/**
 * Function shape used by luaskills_ffi_buffer_clone.
 * luaskills_ffi_buffer_clone 使用的函数形状。
 */
type BufferCloneFunction = (
  value: Buffer | null,
  len: number,
  bufferOut: unknown,
  errorOut: FfiOwnedBuffer,
) => number;

/**
 * Function shape used by JSON provider callback registration entrypoints.
 * JSON provider callback 注册入口使用的函数形状。
 */
type JsonProviderSetterFunction = (
  callback: koffi.IKoffiRegisteredCallback | null,
  userData: null,
  errorOut: FfiOwnedBuffer,
) => number;

/**
 * Native JSON callback slot names managed by this bridge.
 * 当前桥接管理的原生 JSON callback 槽位名称。
 */
type JsonCallbackKind = "sqlite" | "lancedb" | "host-tool" | "skill-operation-progress" | "model-embed" | "model-llm";

/**
 * Module-level JSON callback slot state matching native process-wide slots.
 * 与原生进程级槽位对齐的模块级 JSON callback 槽位状态。
 */
interface JsonProviderSlotState {
  /**
   * Resolved library path owning the native slot.
   * 持有原生槽位的已解析动态库路径。
   */
  libraryPath: string;
  /**
   * SDK instance token that owns the current native callback registration.
   * 持有当前原生 callback 注册的 SDK 实例令牌。
   */
  ownerToken: symbol;
  /**
   * Registered Koffi callback kept alive while the native slot points to it.
   * 原生槽位指向期间保持存活的已注册 Koffi callback。
   */
  registeredCallback: koffi.IKoffiRegisteredCallback;
}

/**
 * Shared JSON callback slot registry for this Node.js process.
 * 当前 Node.js 进程内共享的 JSON callback 槽位注册表。
 */
const JSON_PROVIDER_SLOTS = new Map<string, JsonProviderSlotState>();

/**
 * Shared Koffi type descriptor for LuaSkills owned buffers.
 * LuaSkills 拥有型缓冲的共享 Koffi 类型描述。
 */
const OWNED_BUFFER_TYPE = koffi.struct("FfiOwnedBuffer", {
  ptr: "void *",
  len: "size_t",
});

/**
 * Shared Koffi type descriptor for LuaSkills borrowed buffers.
 * LuaSkills 借用型缓冲的共享 Koffi 类型描述。
 */
const BORROWED_BUFFER_TYPE = koffi.struct("FfiBorrowedBuffer", {
  ptr: "void *",
  len: "size_t",
});

/**
 * Shared Koffi callback type descriptor for JSON provider callbacks.
 * JSON provider callback 的共享 Koffi 回调类型描述。
 */
const JSON_PROVIDER_CALLBACK_TYPE = koffi.proto(
  "int32_t FfiJsonProviderCallback(FfiBorrowedBuffer request_json, void *user_data, FfiOwnedBuffer *response_out, FfiOwnedBuffer *error_out)",
);

/** Native callback descriptor for engine-level managed-session wake notifications. / 引擎级受管会话唤醒通知的原生回调描述符。 */
const MANAGED_SESSION_WAKE_CALLBACK_TYPE = koffi.proto(
  "int32_t FfiManagedSessionWakeCallback(uint64_t engine_id, void *user_data, FfiOwnedBuffer *error_out)",
);

/**
 * Error thrown when a LuaSkills FFI call returns an error envelope.
 * LuaSkills FFI 调用返回错误包络时抛出的错误。
 */
export class LuaSkillsError extends Error {
  /**
   * Name of the FFI function that failed.
   * 失败的 FFI 函数名称。
   */
  readonly functionName: string;

  /**
   * Create one SDK error from an FFI function name and runtime message.
   * 基于 FFI 函数名称与运行时消息创建一个 SDK 错误。
   */
  constructor(functionName: string, message: string) {
    super(`${functionName}: ${message}`);
    this.name = "LuaSkillsError";
    this.functionName = functionName;
  }
}

/**
 * Low-level JSON FFI bridge used by higher-level SDK clients.
 * 高层 SDK 客户端使用的底层 JSON FFI 桥。
 */
export class LuaSkillsJsonFfi {
  /**
   * Loaded koffi dynamic library handle.
   * 已加载的 koffi 动态库句柄。
   */
  private readonly library: ReturnType<typeof koffi.load>;

  /**
   * Resolved dynamic library path used by this bridge.
   * 当前桥接使用的已解析动态库路径。
   */
  private readonly libraryPath: string;

  /**
   * Koffi type descriptor for owned buffers.
   * 拥有型缓冲的 koffi 类型描述。
   */
  private readonly ownedBufferType: koffi.IKoffiCType;

  /**
   * Koffi type descriptor for borrowed buffers.
   * 借用型缓冲的 koffi 类型描述。
   */
  private readonly borrowedBufferType: koffi.IKoffiCType;

  /**
   * Koffi callback type descriptor for JSON provider callbacks.
   * JSON provider callback 的 koffi 回调类型描述。
   */
  private readonly jsonProviderCallbackType: koffi.IKoffiCType;

  /** Live registered wake callbacks keyed by engine id. / 按引擎标识保存的存活唤醒回调。 */
  private readonly managedSessionWakeCallbacks = new Map<number, koffi.IKoffiRegisteredCallback>();

  /**
   * Native buffer-free function exported by LuaSkills.
   * LuaSkills 导出的原生缓冲释放函数。
   */
  private readonly freeBuffer: (value: FfiOwnedBuffer) => void;

  /**
   * Native buffer clone helper used by provider callback returns.
   * provider callback 返回值使用的原生缓冲克隆辅助函数。
   */
  private readonly cloneBuffer: BufferCloneFunction;

  /**
   * Unique owner token used to protect native callback slot cleanup.
   * 用于保护原生 callback 槽位清理的唯一 owner 令牌。
   */
  private readonly providerOwnerToken = Symbol("LuaSkillsJsonFfiProviderOwner");

  /**
   * Cached JSON FFI self-description used for diagnostics.
   * 用于诊断的已缓存 JSON FFI 自描述。
   */
  private describeCache: FfiDescribeResult | null = null;

  /**
   * Create one loaded JSON FFI bridge.
   * 创建一个已加载的 JSON FFI 桥。
   */
  constructor(options: LuaSkillsSdkOptions = {}) {
    const libraryPath = resolveLibraryPath(options.libraryPath, options.runtimeRoot);
    this.libraryPath = libraryPath;
    this.library = koffi.load(libraryPath);
    this.ownedBufferType = OWNED_BUFFER_TYPE;
    this.borrowedBufferType = BORROWED_BUFFER_TYPE;
    this.jsonProviderCallbackType = JSON_PROVIDER_CALLBACK_TYPE;
    this.freeBuffer = this.library.func("void luaskills_ffi_buffer_free(FfiOwnedBuffer value)") as (
      value: FfiOwnedBuffer,
    ) => void;
    this.cloneBuffer = this.library.func(
      "int32_t luaskills_ffi_buffer_clone(const void *value, size_t len, FfiOwnedBuffer *buffer_out, _Out_ FfiOwnedBuffer *error_out)",
    ) as BufferCloneFunction;
  }

  /**
   * Call a JSON FFI entrypoint that does not accept input.
   * 调用一个不接收输入的 JSON FFI 入口。
   */
  callJsonNoInput<T>(functionName: string): T {
    const fn = this.library.func(`FfiOwnedBuffer ${functionName}()`) as JsonNoInputFunction;
    const output = fn();
    return this.decodeEnvelope<T>(functionName, output);
  }

  /**
   * Call a JSON FFI entrypoint with one JSON payload.
   * 使用一个 JSON 载荷调用 JSON FFI 入口。
   */
  callJson<T>(functionName: string, payload: JsonValue | Record<string, unknown>): T {
    const fn = this.library.func(`FfiOwnedBuffer ${functionName}(FfiBorrowedBuffer input_json)`) as JsonInputFunction;
    const text = JSON.stringify(payload);
    const bytes = Buffer.from(text, "utf8");
    const input: FfiBorrowedBuffer = {
      ptr: bytes.length > 0 ? bytes : null,
      len: bytes.length,
    };
    const output = fn(input);
    return this.decodeEnvelope<T>(functionName, output);
  }

  /**
   * Read and cache the exported JSON FFI descriptor payload for diagnostics.
   * 读取并缓存已导出 JSON FFI 描述载荷，供诊断使用。
   */
  describe(): FfiDescribeResult {
    if (this.describeCache === null) {
      this.describeCache = this.callJsonNoInput<FfiDescribeResult>("luaskills_ffi_describe_json");
    }
    return this.describeCache;
  }

  /**
   * Register, replace, or clear one engine-level managed-session wake callback.
   * 注册、替换或清除一个引擎级受管会话唤醒回调。
   */
  setManagedSessionWakeCallback(engineId: number, callback: ManagedSessionWakeCallback | null): void {
    const functionName = "luaskills_ffi_set_managed_session_wake_callback";
    const previous = this.managedSessionWakeCallbacks.get(engineId);
    let registered: koffi.IKoffiRegisteredCallback | null = null;
    if (callback) {
      registered = koffi.register(
        (callbackEngineId: number, _userData: unknown, errorOut: unknown): number => {
          try {
            callback(callbackEngineId);
            return 0;
          } catch (error) {
            try {
              this.cloneOwnedBuffer(Buffer.from(errorMessage(error), "utf8"), errorOut);
            } catch {
              // Callback boundaries must never throw into C.
              // callback 边界绝不能向 C 层抛出异常。
            }
            return 1;
          }
        },
        koffi.pointer(MANAGED_SESSION_WAKE_CALLBACK_TYPE),
      );
    }
    const setter = this.library.func(
      `int32_t ${functionName}(uint64_t engine_id, FfiManagedSessionWakeCallback *callback, void *user_data, _Out_ FfiOwnedBuffer *error_out)`,
    ) as (engineId: number, callback: koffi.IKoffiRegisteredCallback | null, userData: null, errorOut: FfiOwnedBuffer) => number;
    const errorOut = {} as FfiOwnedBuffer;
    const status = setter(engineId, registered, null, errorOut);
    if (status !== 0) {
      if (registered) koffi.unregister(registered);
      const message = this.readOwnedBuffer(errorOut) || "Unknown managed-session wake callback registration error";
      if (errorOut.ptr) this.freeBuffer(errorOut);
      throw new LuaSkillsError(functionName, message);
    }
    if (previous) koffi.unregister(previous);
    if (registered) this.managedSessionWakeCallbacks.set(engineId, registered);
    else this.managedSessionWakeCallbacks.delete(engineId);
  }

  /**
   * Register or clear the SQLite JSON provider callback.
   * 注册或清理 SQLite JSON provider callback。
   */
  setSqliteProviderJsonCallback(callback: JsonProviderCallback | null): void {
    this.setJsonProviderCallback(
      "sqlite",
      "luaskills_ffi_set_sqlite_provider_json_callback",
      callback,
    );
  }

  /**
   * Register or clear the LanceDB JSON provider callback.
   * 注册或清理 LanceDB JSON provider callback。
   */
  setLanceDbProviderJsonCallback(callback: JsonProviderCallback | null): void {
    this.setJsonProviderCallback(
      "lancedb",
      "luaskills_ffi_set_lancedb_provider_json_callback",
      callback,
    );
  }

  /**
   * Register or clear the host-tool JSON callback.
   * 注册或清理宿主工具 JSON callback。
   */
  setHostToolJsonCallback(callback: HostToolJsonCallback | null): void {
    this.setJsonProviderCallback(
      "host-tool",
      "luaskills_ffi_set_host_tool_json_callback",
      callback,
    );
  }

  /**
   * Register or clear the skill operation progress JSON callback.
   * 注册或清理 skill 操作进度 JSON callback。
   */
  setSkillOperationProgressJsonCallback(callback: SkillOperationProgressCallback | null): void {
    this.setJsonProviderCallback(
      "skill-operation-progress",
      "luaskills_ffi_set_skill_operation_progress_json_callback",
      callback,
    );
  }

  /**
   * Register or clear the model embedding JSON callback.
   * 注册或清理模型 embedding JSON callback。
   */
  setModelEmbedJsonCallback(callback: ModelEmbedJsonCallback | null): void {
    this.setJsonProviderCallback(
      "model-embed",
      "luaskills_ffi_set_model_embed_json_callback",
      callback,
    );
  }

  /**
   * Register or clear the model LLM JSON callback.
   * 注册或清理模型 LLM JSON callback。
   */
  setModelLlmJsonCallback(callback: ModelLlmJsonCallback | null): void {
    this.setJsonProviderCallback(
      "model-llm",
      "luaskills_ffi_set_model_llm_json_callback",
      callback,
    );
  }

  /**
   * Clear the SQLite JSON provider callback slot.
   * 清理 SQLite JSON provider callback 槽位。
   */
  clearSqliteProviderJsonCallback(): void {
    this.setSqliteProviderJsonCallback(null);
  }

  /**
   * Clear the LanceDB JSON provider callback slot.
   * 清理 LanceDB JSON provider callback 槽位。
   */
  clearLanceDbProviderJsonCallback(): void {
    this.setLanceDbProviderJsonCallback(null);
  }

  /**
   * Clear the host-tool JSON callback slot.
   * 清理宿主工具 JSON callback 槽位。
   */
  clearHostToolJsonCallback(): void {
    this.setHostToolJsonCallback(null);
  }

  /**
   * Clear the skill operation progress JSON callback slot.
   * 清理 skill 操作进度 JSON callback 槽位。
   */
  clearSkillOperationProgressJsonCallback(): void {
    this.setSkillOperationProgressJsonCallback(null);
  }

  /**
   * Clear the model embedding JSON callback slot.
   * 清理模型 embedding JSON callback 槽位。
   */
  clearModelEmbedJsonCallback(): void {
    this.setModelEmbedJsonCallback(null);
  }

  /**
   * Clear the model LLM JSON callback slot.
   * 清理模型 LLM JSON callback 槽位。
   */
  clearModelLlmJsonCallback(): void {
    this.setModelLlmJsonCallback(null);
  }

  /**
   * Clear every JSON callback slot currently owned by this FFI bridge.
   * 清理当前 FFI 桥持有的全部 JSON callback 槽位。
   */
  clearJsonProviderCallbacks(): void {
    this.clearSqliteProviderJsonCallback();
    this.clearLanceDbProviderJsonCallback();
    this.clearHostToolJsonCallback();
    this.clearSkillOperationProgressJsonCallback();
    this.clearModelEmbedJsonCallback();
    this.clearModelLlmJsonCallback();
  }

  /**
   * Decode one owned FFI buffer into a typed JSON envelope and free it.
   * 将一个拥有型 FFI 缓冲解码为类型化 JSON 包络并释放它。
   */
  private decodeEnvelope<T>(functionName: string, output: FfiOwnedBuffer): T {
    const text = this.readOwnedBuffer(output);
    this.freeBuffer(output);
    return this.decodeEnvelopeText<T>(functionName, text);
  }

  /**
   * Decode one JSON FFI envelope text into a typed result payload.
   * 将单个 JSON FFI 包络文本解码为类型化结果载荷。
   */
  private decodeEnvelopeText<T>(functionName: string, text: string): T {
    if (text.trim() === "") {
      throw new LuaSkillsError(functionName, "empty JSON FFI response envelope");
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(text);
    } catch (error) {
      throw new LuaSkillsError(functionName, `invalid JSON FFI response envelope: ${errorMessage(error)}`);
    }
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
      throw new LuaSkillsError(functionName, "JSON FFI response envelope must be one object");
    }
    const envelope = decoded as FfiJsonEnvelope<T>;
    if (!envelope.ok) {
      throw new LuaSkillsError(functionName, envelope.error ?? "Unknown LuaSkills FFI error");
    }
    return envelope.result as T;
  }

  /**
   * Read one owned FFI buffer into UTF-8 text without freeing it.
   * 将一个拥有型 FFI 缓冲读取为 UTF-8 文本但不释放它。
   */
  private readOwnedBuffer(output: FfiOwnedBuffer): string {
    if (!output.ptr || Number(output.len) === 0) {
      return "";
    }
    return Buffer.from(koffi.view(output.ptr, Number(output.len))).toString("utf8");
  }

  /**
   * Register or clear one concrete JSON provider callback slot.
   * 注册或清理一个具体 JSON provider callback 槽位。
   */
  private setJsonProviderCallback<Request extends JsonValue = JsonValue>(
    kind: JsonCallbackKind,
    functionName: string,
    callback: JsonCallback<Request> | null,
  ): void {
    const slotKey = this.jsonProviderSlotKey(kind);
    const previousSlot = JSON_PROVIDER_SLOTS.get(slotKey);
    if (!callback) {
      if (previousSlot?.ownerToken !== this.providerOwnerToken) {
        return;
      }
      this.callProviderSetter(functionName, null);
      koffi.unregister(previousSlot.registeredCallback);
      JSON_PROVIDER_SLOTS.delete(slotKey);
      return;
    }

    const registeredCallback = koffi.register(
      (requestJson: FfiBorrowedBuffer, _userData: unknown, responseOut: unknown, errorOut: unknown): number => {
        try {
          const request = this.parseBorrowedJson(requestJson) as Request;
          const response = callback(request);
          this.cloneOwnedBuffer(serializeProviderJson(response), responseOut);
          return 0;
        } catch (error) {
          try {
            this.cloneOwnedBuffer(Buffer.from(errorMessage(error), "utf8"), errorOut);
          } catch {
            // Callback boundaries must not throw into C.
            // callback 边界不能向 C 层抛出异常。
          }
          return 1;
        }
      },
      koffi.pointer(this.jsonProviderCallbackType),
    );

    try {
      this.callProviderSetter(functionName, registeredCallback);
    } catch (error) {
      koffi.unregister(registeredCallback);
      throw error;
    }

    if (previousSlot) {
      koffi.unregister(previousSlot.registeredCallback);
    }
    JSON_PROVIDER_SLOTS.set(slotKey, {
      libraryPath: this.libraryPath,
      ownerToken: this.providerOwnerToken,
      registeredCallback,
    });
  }

  /**
   * Call one provider callback setter and surface any native error.
   * 调用单个 provider callback setter 并暴露原生错误。
   */
  private callProviderSetter(functionName: string, callback: koffi.IKoffiRegisteredCallback | null): void {
    const setter = this.library.func(
      `int32_t ${functionName}(FfiJsonProviderCallback *callback, void *user_data, _Out_ FfiOwnedBuffer *error_out)`,
    ) as JsonProviderSetterFunction;
    const errorOut = {} as FfiOwnedBuffer;
    const status = setter(callback, null, errorOut);
    if (status === 0) {
      if (errorOut.ptr) {
        this.freeBuffer(errorOut);
      }
      return;
    }
    const message = this.readOwnedBuffer(errorOut) || "Unknown provider callback registration error";
    if (errorOut.ptr) {
      this.freeBuffer(errorOut);
    }
    throw new LuaSkillsError(functionName, message);
  }

  /**
   * Parse one borrowed JSON buffer passed by the native provider bridge.
   * 解析原生 provider 桥传入的单个借用 JSON 缓冲。
   */
  private parseBorrowedJson(input: FfiBorrowedBuffer): JsonValue {
    if (!input.ptr || Number(input.len) === 0) {
      return null;
    }
    return JSON.parse(Buffer.from(koffi.view(input.ptr, Number(input.len))).toString("utf8")) as JsonValue;
  }

  /**
   * Clone one JavaScript-owned payload into one native owned buffer output.
   * 将单个 JavaScript 拥有的载荷克隆到一个原生拥有型缓冲输出。
   */
  private cloneOwnedBuffer(payload: Buffer, bufferOut: unknown): void {
    const errorOut = {} as FfiOwnedBuffer;
    const status = this.cloneBuffer(payload.length > 0 ? payload : null, payload.length, bufferOut, errorOut);
    if (status === 0) {
      return;
    }
    const message = this.readOwnedBuffer(errorOut) || "Unknown buffer clone error";
    if (errorOut.ptr) {
      this.freeBuffer(errorOut);
    }
    throw new LuaSkillsError("luaskills_ffi_buffer_clone", message);
  }

  /**
   * Build a process-local JSON callback slot key for one library path and callback kind.
   * 为单个动态库路径和 callback 类型构造进程内 JSON callback 槽位键。
   */
  private jsonProviderSlotKey(kind: JsonCallbackKind): string {
    return `${this.libraryPath}:${kind}`;
  }
}

/**
 * Serialize one provider callback response into UTF-8 JSON bytes.
 * 将单个 provider callback 响应序列化为 UTF-8 JSON 字节。
 */
function serializeProviderJson(value: JsonValue | undefined): Buffer {
  return Buffer.from(JSON.stringify(value ?? null), "utf8");
}

/**
 * Convert an unknown thrown value into a stable error string.
 * 将未知抛出值转换为稳定错误字符串。
 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Resolve the dynamic library path from options or environment variables.
 * 从选项或环境变量解析动态库路径。
 */
export function resolveLibraryPath(explicitPath?: string, runtimeRoot?: string): string {
  const selectedPath = explicitPath ?? process.env.LUASKILLS_LIB ?? (runtimeRoot ? resolveLuaSkillsLibraryPathFromRuntime(runtimeRoot) : null);
  if (!selectedPath) {
    throw new Error("LuaSkills library path is required; pass libraryPath, set LUASKILLS_LIB, or install runtime assets under runtimeRoot");
  }
  const absolutePath = resolve(selectedPath);
  if (!existsSync(absolutePath)) {
    throw new Error(`LuaSkills library not found: ${absolutePath}`);
  }
  return absolutePath;
}
