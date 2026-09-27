import { AsyncLocalStorage } from "node:async_hooks";
import type { EmbeddedJsonValue, InputCapabilityDescriptor, InputEffectState, InputEmbeddedError, InputEmbeddedErrorCode, OutputCapabilityCaller, OutputEmbeddedError, OutputHostRequest } from "./embedded-contract.js";
import { decodeEmbeddedJson, embeddedUnsignedInteger, encodeEmbeddedJson } from "./embedded-json.js";
import { EmbeddedRuntimeError } from "./embedded-transport.js";

/** Both synchronous and promise-returning handlers run on the owning Node event loop.
 * 同步处理器及返回 Promise 的处理器均在所属 Node 事件循环中运行。 */
export type EmbeddedHostHandler = (argumentsValue: EmbeddedJsonValue, context: HostCallbackContext) => EmbeddedJsonValue | PromiseLike<EmbeddedJsonValue>;

/** Internal exact handler owner inherited by asynchronous continuations for self-drain guards.
 * 异步继续执行继承的内部精确处理器所有者，用于阻止等待自身排空。 */
export const HOST_CALLBACK_OWNER = new AsyncLocalStorage<object>();

// The exhaustive map is compiler-checked against the generated protocol union.
// 完整映射由编译器对照生成协议联合类型校验。
const EFFECT_STATES: Readonly<Record<InputEffectState, true>> = Object.freeze({ not_started: true, not_applicable: true, committed: true, rolled_back: true, unknown: true });
// Stable explicit SDK errors may be delivered; arbitrary host exceptions use a generic diagnostic.
// 稳定显式 SDK 错误可以交付；任意宿主异常使用通用诊断。
const ERROR_CODES: Readonly<Record<InputEmbeddedErrorCode, true>> = Object.freeze({ invalid_argument: true, not_found: true, stale_generation: true, capacity_exceeded: true, busy: true, already_completed: true, closed: true, cancelled: true, deadline_exceeded: true, permission_denied: true, unsupported: true, execution_failed: true, cleanup_failed: true, internal: true });

/**
 * Preserve declared SDK errors without exposing arbitrary host exception messages or arguments.
 * 保留声明的 SDK 错误，不暴露任意宿主异常消息或参数。
 * @param error Actual handler exception.
 * 实际处理器异常。
 * @returns Protocol-valid structured failure.
 * 符合协议的结构化失败。
 * @internal
 */
export function callbackFailure(error: unknown): InputEmbeddedError {
  if (error instanceof EmbeddedRuntimeError && Object.hasOwn(ERROR_CODES, error.code)) return { code: error.code as InputEmbeddedErrorCode, message: error.message };
  return { code: "execution_failed", message: "JavaScript host callback failed" };
}

/**
 * Freeze decoded owned JSON recursively; no application objects or accessors enter this helper.
 * 递归冻结已解码的拥有型 JSON；此辅助函数不接收应用对象或访问器。
 * @param value Independently decoded JSON value.
 * 独立解码的 JSON 值。
 * @returns The same deeply frozen owned value.
 * 同一个深度冻结的拥有型值。
 * @internal
 */
export function freezeCallbackJson<T extends EmbeddedJsonValue>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeCallbackJson(child);
    Object.freeze(value);
  }
  return value;
}

/** Snapshot owned by the pump after bounded encoding; handler identity is retained exactly.
 * 有界编码后由泵拥有的快照；处理器身份精确保留。
 * @internal
 */
export interface HostCapabilitySnapshot {
  /** Immutable private descriptor copy.
   * 不可变私有描述符副本。 */
  readonly descriptor: InputCapabilityDescriptor;
  /** Exact supplied handler; never serialized into a worker.
   * 精确提供的处理器；绝不序列化到工作线程。 */
  readonly handler: EmbeddedHostHandler;
}

/** Bind a queued capability declaration to a retained JavaScript handler.
 * 将队列能力声明绑定到保留的 JavaScript 处理器。 */
export class HostCapability {
  // Declaration aliases are copied at registration, under that transport's exact byte limit.
  // 声明别名在注册时按该传输的精确字节限制复制。
  readonly #descriptor: InputCapabilityDescriptor;
  readonly #handler: EmbeddedHostHandler;

  /**
   * Retain a declaration until registration freezes it; no native registration occurs here.
   * 保留声明直到注册时冻结；此处不进行原生注册。
   * @param descriptor Exact generated queued capability declaration.
   * 精确生成的队列能力声明。
   * @param handler Nonblocking synchronous or asynchronous host implementation.
   * 不阻塞事件循环的同步或异步宿主实现。
   */
  constructor(descriptor: InputCapabilityDescriptor, handler: EmbeddedHostHandler) {
    if (typeof handler !== "function") throw new TypeError("Host capability requires a callable handler");
    this.#descriptor = descriptor;
    this.#handler = handler;
    Object.freeze(this);
  }

  /**
   * Snapshot the exact descriptor without invoking serialization hooks or cloning the handler.
   * 精确复制描述符，不调用序列化钩子，也不克隆处理器。
   * @param maxBytes Owning transport request-byte bound.
   * 所属传输请求字节上限。
   * @returns Owned immutable descriptor and exact handler.
   * 拥有型不可变描述符及精确处理器。
   * @internal
   */
  snapshot(maxBytes: bigint): HostCapabilitySnapshot {
    const descriptor = decodeEmbeddedJson(encodeEmbeddedJson(this.#descriptor, maxBytes)) as InputCapabilityDescriptor;
    if (descriptor.execution !== "queued") throw new TypeError("Host capabilities require explicitly queued execution");
    return Object.freeze({ descriptor: freezeCallbackJson(descriptor), handler: this.#handler });
  }
}

/** Trusted immutable caller metadata, cooperative cancellation and explicit effect reporting.
 * 可信不可变调用方元数据、协作取消及显式副作用报告。 */
export class HostCallbackContext {
  // Identity and advisory deadline derive solely from the core's delivered request.
  // 身份及参考截止时间仅从核心已交付请求派生。
  readonly #requestId: string;
  readonly #registrationId: string;
  readonly #caller: Readonly<OutputCapabilityCaller>;
  readonly #deadlineNs: bigint;
  readonly #controller = new AbortController();
  // Completion seals effect evidence even if a host keeps a context alias.
  // 完成会封存副作用证据，即使宿主仍保留上下文别名。
  #effects: InputEffectState;
  #cancellation: Readonly<OutputEmbeddedError> | null = null;
  #sealed = false;

  /**
   * Bind authenticated core metadata to one delivered handler's declared effect category.
   * 将已认证核心元数据绑定到一个已交付处理器声明的副作用类别。
   * @param request Exact core-delivered request, separate from its application arguments.
   * 精确核心已交付请求，独立于其中的应用参数。
   * @param effects Declared read-only or mutating category.
   * 声明的只读或变更类别。
   * @internal
   */
  constructor(request: OutputHostRequest, effects: InputCapabilityDescriptor["effects"]) {
    if (effects !== "read_only" && effects !== "mutating") throw new TypeError("Unknown capability effects declaration");
    this.#requestId = request.request_id;
    this.#registrationId = request.registration_id;
    this.#caller = Object.freeze({ ...request.caller });
    this.#deadlineNs = process.hrtime.bigint() + embeddedUnsignedInteger(request.remaining_ms, "callback remaining_ms") * 1_000_000n;
    this.#effects = effects === "read_only" ? "not_applicable" : "unknown";
    Object.freeze(this);
  }

  /** Exact never-reused request identity used for acknowledgement.
   * 用于确认且绝不复用的精确请求身份。 */
  get requestId(): string { return this.#requestId; }
  /** Exact registration that selected this retained handler.
   * 选择此保留处理器的精确注册身份。 */
  get registrationId(): string { return this.#registrationId; }
  /** Immutable caller authority; application arguments cannot change it.
   * 不可变调用方权威；应用参数不能修改它。 */
  get caller(): Readonly<OutputCapabilityCaller> { return this.#caller; }
  /** Most recent explicit host effect evidence, independent of success or cancellation.
   * 最近的显式宿主副作用证据，独立于成功或取消。 */
  get effects(): InputEffectState { return this.#effects; }
  /** First authoritative core cancellation reason, or null before it is observed.
   * 首次权威核心取消原因；观察到之前为 null。 */
  get cancellation(): Readonly<OutputEmbeddedError> | null { return this.#cancellation; }
  /** Signal observes cancellation; abort is never treated as proof of handler termination.
   * 信号观察取消；中止绝不被视为处理器终止证明。 */
  get signal(): AbortSignal { return this.#controller.signal; }
  /** Nonnegative advisory duration in exact integer milliseconds; the core owns the real deadline.
   * 精确整数毫秒表示的非负参考时长；核心拥有真实截止时间。 */
  get remainingMs(): bigint { const remaining = this.#deadlineNs - process.hrtime.bigint(); return remaining > 0n ? remaining / 1_000_000n : 0n; }

  /**
   * Report actual transaction evidence while the handler remains active.
   * 在处理器仍活动时报告实际事务证据。
   * @param effects Explicit protocol effect state; never inferred from a return value.
   * 显式协议副作用状态；绝不从返回值推断。
   */
  reportEffects(effects: InputEffectState): void {
    if (this.#sealed) throw new Error("Host callback effect evidence is sealed");
    if (typeof effects !== "string" || !Object.hasOwn(EFFECT_STATES, effects)) throw new TypeError("Unknown host effect state");
    this.#effects = effects;
  }

  /** Throw the exact observed cancellation without implying rollback or actual termination.
   * 抛出精确观察到的取消，不代表回滚或实际终止。 */
  throwIfCancelled(): void { this.#controller.signal.throwIfAborted(); }

  /**
   * Publish the first core cancellation to cooperative host code.
   * 向协作宿主代码发布首次核心取消。
   * @param reason Exact core status error.
   * 精确核心状态错误。
   * @internal
   */
  observeCancellation(reason: OutputEmbeddedError): void {
    if (this.#cancellation !== null) return;
    this.#cancellation = Object.freeze({ ...reason });
    this.#controller.abort(new EmbeddedRuntimeError(reason.code, reason.message));
  }

  /** Seal after the actual handler returns; later aliases cannot rewrite its acknowledgement.
   * 实际处理器返回后封存；迟到别名不能改写其确认。
   * @internal
   */
  seal(): void { this.#sealed = true; }
}
