import { types } from "node:util";
import { EmbeddedCallbackExecutor, EmbeddedCommand, completion, observe, type Completion } from "./embedded-driver.js";
import { HostCapability, HostCallbackContext, HOST_CALLBACK_OWNER, callbackFailure, freezeCallbackJson, type HostCapabilitySnapshot } from "./embedded-callbacks.js";
import { decodeEmbeddedJson, encodeEmbeddedJson } from "./embedded-json.js";
import { EmbeddedResultReleaseError, EmbeddedRuntimeError, EmbeddedTransport, EmbeddedTransportError } from "./embedded-transport.js";
import { EMBEDDED_PROTOCOL_VERSION, EmbeddedNativeStatus, type EmbeddedJsonValue, type EmbeddedRuntimeResponseMap, type InputCommand, type InputHostCompletion, type OutputHostRequest, type OutputRuntimeSnapshot } from "./embedded-contract.js";

/** Explicit callback concurrency, registration admission and polling limits.
 * 显式回调并发、注册入场及轮询限制。 */
export interface CallbackPumpConfig {
  /** Delivered handlers including completed outcomes whose acknowledgements are still retained.
   * 已交付处理器数量，包含仍保留待确认完成结果的处理器。 */
  readonly maxConcurrentHandlers: number;
  /** Accepted registration batches, including uncertain publications requiring explicit recovery.
   * 已接纳注册批次数量，包含需要显式恢复的不确定发布。 */
  readonly maxPendingCommands: number;
  /** Core cancellation and drainage polling interval in milliseconds.
   * 核心取消及排空轮询间隔毫秒数。 */
  readonly pollIntervalMs: number;
}

/** One immutable handler registration retained until native and JavaScript ownership both drain.
 * 一个不可变处理器注册，保留到原生及 JavaScript 所有权均排空。 */
interface Registration {
  /** Core identity and exact retained declaration.
   * 核心身份及精确保留声明。 */
  readonly id: string;
  readonly capability: HostCapabilitySnapshot;
  /** Unregister intent and proven native acknowledgement are distinct checkpoints.
   * 注销意图和已证明原生确认是不同检查点。 */
  retiring: boolean;
  retired: boolean;
  /** An uncertain native mutation keeps its original receipt and is never automatically replayed.
   * 不确定原生变更保留原始回执，绝不自动重放。 */
  mutation: { type: "capability_unregister" | "capability_forget"; receipt: EmbeddedCommand | null } | null;
  /** Shared completion observed by every unregister caller.
   * 每个注销调用方观察的共享完成对象。 */
  readonly drained: Completion;
}

/** Accepted publication retains handlers even when its native response is uncertain.
 * 已接纳发布即使原生响应不确定也保留处理器。 */
interface Publication {
  /** Exact batch snapshot and its immutable command.
   * 精确批次快照及其不可变命令。 */
  readonly capabilities: readonly HostCapabilitySnapshot[];
  readonly command: InputCommand;
  /** Native receipt is retained until publication is proven or rejected before dispatch.
   * 原生回执保留到发布被证明或在分发前被拒绝。 */
  receipt: EmbeddedCommand | null;
  /** Whether the one allowed publication attempt has started.
   * 唯一允许的发布尝试是否已开始。 */
  attempted: boolean;
  /** Actual acknowledged identities, independent from observation cancellation.
   * 实际已确认身份，独立于观察取消。 */
  identities: readonly string[] | null;
  readonly finished: Completion;
}

/** Delivered callback ownership survives handler return, cancellation and acknowledgement failures.
 * 已交付回调所有权跨处理器返回、取消及确认失败存活。 */
interface DeliveredRequest {
  /** Core request and exact handler owner; absent owner never routes by capability name.
   * 核心请求及精确处理器所有者；缺失所有者时绝不按能力名称重路由。 */
  readonly request: OutputHostRequest;
  readonly registration: Registration | null;
  /** Trusted context exists only for an owned handler.
   * 可信上下文仅存在于拥有型处理器。 */
  context: HostCallbackContext | null;
  /** Completion is absent while the actual handler is running.
   * 实际处理器运行期间完成结果不存在。 */
  outcome: InputHostCompletion | null;
  command: InputCommand | null;
  /** Only explicit recovery can re-deliver a failed acknowledgement.
   * 只有显式恢复才能重新交付失败确认。 */
  acknowledgementFailed: boolean;
}

/** Exact runtime command discriminant from the generated contract.
 * 来自生成契约的精确运行时命令判别类型。 */
type RuntimeOperation = Extract<InputCommand, { type: "runtime" }>["operation"];

// A sequential coordinator owns one native receipt at a time on its independent control worker.
// 顺序协调器在独立控制工作线程上每次拥有一个原生回执。
const PUMP_NATIVE_RECEIPTS = 1;
// Node timers accept at most this signed 32-bit delay without coercing it to a short timer.
// Node 定时器至多接受此有符号 32 位延迟，超过后会转换为短定时器。
const MAX_TIMER_DELAY_MS = 2_147_483_647;
// All declared fields are required data properties, never executable accessors.
// 全部声明字段均为必需数据属性，绝不接受可执行访问器。
const CONFIG_FIELDS = ["maxConcurrentHandlers", "maxPendingCommands", "pollIntervalMs"] as const;
// Real pumps remain discoverable until handlers, acknowledgements and native workers have all drained.
// 实际泵保持可发现，直到处理器、确认及原生工作线程全部排空。
const LIVE_PUMPS = new Set<EmbeddedCallbackPump>();

/** One runtime's owned queue pump with cooperative callbacks and independent native control capacity.
 * 一个运行时的拥有型队列泵，包含协作回调及独立原生控制容量。 */
export class EmbeddedCallbackPump {
  // Exact borrowed transport and immutable runtime identity govern every native command.
  // 精确借用传输及不可变运行时身份约束每个原生命令。
  readonly #transport: EmbeddedTransport;
  readonly #runtimeId: string;
  readonly #config: Readonly<CallbackPumpConfig>;
  readonly #executor: EmbeddedCallbackExecutor;
  // The coordinator is the only native mutation owner; handler tasks only publish frozen outcomes.
  // 协调器是唯一原生变更所有者；处理器任务仅发布冻结完成结果。
  readonly #registrations = new Map<string, Registration>();
  readonly #publications = new Set<Publication>();
  readonly #requests = new Map<string, DeliveredRequest>();
  readonly #tasks = new Set<Promise<void>>();
  // Taking a batch transfers native ownership even before JavaScript receives its acknowledgement.
  // 提取批次即转移原生所有权，即使 JavaScript 尚未收到其确认。
  #extraction: { receipt: EmbeddedCommand | null } | null = null;
  readonly #started = completion();
  readonly #stopped = completion();
  #wake = completion();
  #retry: Completion | null = null;
  #closing = false;
  #closed = false;
  #ready = false;
  #needsRelease = false;
  #failure: Error | null = null;
  #serviceEnded = false;

  /**
   * Start one exact runtime pump; readiness additionally verifies native initialization and open admission.
   * 启动一个精确运行时泵；就绪还要求验证原生初始化及开放入场。
   * @param transport Live transport borrowed until actual pump and worker drainage.
   * 借用到实际泵及工作线程排空为止的活动传输。
   * @param runtimeId Exact native runtime identity; one pump is allowed per transport/runtime pair.
   * 精确原生运行时身份；每个传输与运行时组合仅允许一个泵。
   * @param config Explicit positive data-only callback bounds.
   * 显式正数纯数据回调限制。
   */
  constructor(transport: EmbeddedTransport, runtimeId: string, config: CallbackPumpConfig) {
    if (config === null || typeof config !== "object" || types.isProxy(config)) throw new TypeError("Callback pump requires exactly three data limits");
    const descriptors = Object.getOwnPropertyDescriptors(config);
    if (Reflect.ownKeys(descriptors).length !== CONFIG_FIELDS.length || CONFIG_FIELDS.some((key) => !Object.hasOwn(descriptors, key) || !("value" in descriptors[key]))) throw new TypeError("Callback pump requires exactly three data limits");
    const normalized = {} as Record<keyof CallbackPumpConfig, number>;
    for (const key of CONFIG_FIELDS) {
      const value: unknown = descriptors[key].value;
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${key} must be a positive safe integer`);
      normalized[key] = value;
    }
    if (normalized.pollIntervalMs > MAX_TIMER_DELAY_MS) throw new RangeError("Callback poll interval exceeds Node timer range");
    this.#transport = transport;
    this.#runtimeId = runtimeId;
    this.#config = Object.freeze(normalized);
    this.#executor = new EmbeddedCallbackExecutor(transport, runtimeId, PUMP_NATIVE_RECEIPTS);
    LIVE_PUMPS.add(this);
    void this.run().then(() => { this.#serviceEnded = true; }, (error) => {
      this.#serviceEnded = true;
      this.fail(error);
      this.#started.reject(error);
      this.#stopped.reject(error);
      for (const publication of this.#publications) publication.finished.reject(error);
      for (const registration of this.#registrations.values()) registration.drained.reject(error);
      this.#retry?.reject(error);
    });
  }

  /** Actual retained owners, including failed pumps awaiting explicit recovery.
   * 实际保留所有者，包含等待显式恢复的失败泵。 */
  static get live(): readonly EmbeddedCallbackPump[] { return Object.freeze([...LIVE_PUMPS]); }
  /** Exact runtime identity borrowed by this pump.
   * 此泵借用的精确运行时身份。 */
  get runtimeId(): string { return this.#runtimeId; }
  /** Frozen SDK ownership diagnostics; no native terminal state is inferred.
   * 冻结 SDK 所有权诊断；不推断原生终态。 */
  get status(): Readonly<{ ready: boolean; closing: boolean; closed: boolean; registrationIds: readonly string[]; requestIds: readonly string[]; pendingAcknowledgements: readonly string[]; pendingCommands: number; pendingExtraction: boolean; needsResultRelease: boolean; failure: string | null }> {
    return Object.freeze({ ready: this.#ready, closing: this.#closing, closed: this.#closed, registrationIds: Object.freeze([...this.#registrations.keys()]), requestIds: Object.freeze([...this.#requests.keys()]), pendingAcknowledgements: Object.freeze([...this.#requests.values()].filter((record) => record.outcome !== null).map((record) => record.request.request_id)), pendingCommands: this.#publications.size, pendingExtraction: this.#extraction !== null, needsResultRelease: this.#needsRelease, failure: this.#failure?.message ?? null });
  }

  /** Observe actual startup; cancellation only detaches this observer.
   * 观察实际启动；取消仅分离此观察者。 */
  ready(options: { signal?: AbortSignal } = {}): Promise<void> { return observe(this.#started.promise, options.signal); }

  /**
   * Freeze and publish one atomic handler batch before it can receive requests.
   * 在能够接收请求之前，冻结并发布一个原子处理器批次。
   * @param capabilities Explicit queued handler declarations; mutation after admission has no effect.
   * 显式队列处理器声明；入场后修改不产生影响。
   * @param options Optional observer cancellation; published handlers remain owned and queryable.
   * 可选观察者取消；已发布处理器继续拥有且可查询。
   * @returns Exact immutable registration identities, in the declared batch order.
   * 按声明批次顺序返回精确不可变注册身份。
   */
  async register(capabilities: readonly HostCapability[], options: { signal?: AbortSignal } = {}): Promise<readonly string[]> {
    this.checkObserver();
    if (!this.#ready || this.#closing) throw new EmbeddedRuntimeError("closed", "Callback pump is not accepting registrations");
    if (this.#publications.size >= this.#config.maxPendingCommands) throw new EmbeddedRuntimeError("capacity_exceeded", "Callback publication capacity is exhausted");
    if (!Array.isArray(capabilities) || types.isProxy(capabilities)) throw new TypeError("Callback registration requires an array of HostCapability instances");
    const entries = Object.getOwnPropertyDescriptors(capabilities);
    if (Reflect.ownKeys(entries).length !== capabilities.length + 1) throw new TypeError("Callback batch must contain only dense array data entries");
    const snapshots: HostCapabilitySnapshot[] = [];
    let remainingBytes = this.#transport.config.max_request_bytes;
    for (let index = 0; index < capabilities.length; index += 1) {
      const descriptor = entries[String(index)];
      if (!descriptor || !("value" in descriptor)) throw new TypeError("Callback batch must contain only dense array data entries");
      const capability: unknown = descriptor.value;
      if (types.isProxy(capability) || !(capability instanceof HostCapability)) throw new TypeError("Callback registration requires HostCapability instances");
      const snapshot = HostCapability.prototype.snapshot.call(capability, remainingBytes);
      remainingBytes -= BigInt(encodeEmbeddedJson(snapshot.descriptor, remainingBytes).length);
      snapshots.push(snapshot);
    }
    const command = this.freezeCommand({ type: "runtime", runtime_id: this.#runtimeId, operation: { type: "capabilities_register", descriptors: snapshots.map((item) => item.descriptor) } });
    const publication: Publication = { capabilities: Object.freeze(snapshots), command, attempted: false, receipt: null, identities: null, finished: completion() };
    // Promise initialization can invoke async hooks; revalidate admission immediately before publication.
    // Promise 初始化可能调用异步钩子；在发布之前立即重新校验入场。
    if (!this.#ready || this.#closing || this.#publications.size >= this.#config.maxPendingCommands) throw new EmbeddedRuntimeError("capacity_exceeded", "Callback publication admission changed during preparation");
    this.#publications.add(publication);
    this.wake();
    await observe(publication.finished.promise, options.signal);
    if (publication.identities === null) throw new Error("Callback publication completed without identities");
    return publication.identities;
  }

  /**
   * Request exact unregister and wait for real native and JavaScript handler drainage.
   * 请求精确注销，并等待真实原生及 JavaScript 处理器排空。
   * @param registrationId Exact owned registration, never resolved by name.
   * 精确拥有注册，绝不按名称解析。
   * @param options Optional cancellation of this observation only.
   * 可选且仅作用于此观察的取消。
   * @returns Actual registration drainage and native metadata removal.
   * 实际注册排空及原生元数据移除。
   */
  unregister(registrationId: string, options: { signal?: AbortSignal } = {}): Promise<void> {
    this.checkObserver();
    const registration = this.#registrations.get(registrationId);
    if (!registration) throw new EmbeddedRuntimeError("not_found", "Callback registration is not owned by this pump");
    registration.retiring = true;
    this.wake();
    return observe(registration.drained.promise, options.signal);
  }

  /**
   * Reconcile failed publication and acknowledgement evidence, then retry only exact acknowledgement bytes.
   * 核对失败发布及确认证据，然后仅重试精确确认字节。
   * @param options Optional observer cancellation; recovery keeps its own completion owner.
   * 可选观察者取消；恢复保留自身完成所有者。
   * @returns This explicit recovery attempt, without any handler replay.
   * 此次显式恢复尝试，绝不重放处理器。
   */
  retryAcknowledgements(options: { signal?: AbortSignal } = {}): Promise<void> {
    this.checkObserver();
    if (this.#closed || this.#serviceEnded) throw new EmbeddedRuntimeError("closed", "Callback pump coordinator has stopped");
    if (this.#retry === null) this.#retry = completion();
    this.wake();
    return observe(this.#retry.promise, options.signal);
  }

  /**
   * Close admission, revoke owned registrations and wait for callbacks, acknowledgements and worker exit.
   * 关闭入场、撤销拥有注册，并等待回调、确认及工作线程退出。
   * @param options Optional observer-only abort; no handler is forcibly terminated.
   * 可选且仅作用于观察者的中止；不会强制终止处理器。
   * @returns Actual pump drainage; borrowed native runtime and transport remain caller-owned.
   * 实际泵排空；借用原生运行时及传输继续由调用方拥有。
   */
  close(options: { signal?: AbortSignal } = {}): Promise<void> {
    this.checkObserver();
    this.#closing = true;
    if (!this.#ready) this.#started.reject(new Error("Callback pump closed before becoming ready"));
    this.wake();
    return observe(this.#stopped.promise, options.signal);
  }

  /** Reject operations that would wait for their own still-active callback.
   * 拒绝会等待自身仍活动回调的操作。 */
  private checkObserver(): void {
    if (HOST_CALLBACK_OWNER.getStore() === this) throw new EmbeddedRuntimeError("unsupported", "A callback cannot wait for its own pump");
  }

  /** Publish an advisory wake without discarding any authoritative owned work.
   * 发布参考唤醒，不丢弃任何权威拥有工作。 */
  private wake(): void { this.#wake.resolve(); }

  /**
   * Retain the first infrastructure failure and fence new callback admission.
   * 保留首次基础设施失败，并阻止新回调入场。
   * @param reason Actual SDK or native boundary failure.
   * 实际 SDK 或原生边界失败。
   */
  private fail(reason: unknown): void {
    const first = this.#failure === null;
    if (first) this.#failure = reason instanceof Error ? reason : new Error(String(reason));
    this.#closing = true;
    if (first) this.wake();
  }

  /**
   * Freeze a complete command under the owning transport's existing byte authority.
   * 按所属传输已有字节权威冻结完整命令。
   * @param command Exact generated native command.
   * 精确生成原生命令。
   * @returns Independently copied immutable command.
   * 独立复制的不可变命令。
   */
  private freezeCommand(command: InputCommand): InputCommand {
    const envelope = decodeEmbeddedJson(encodeEmbeddedJson({ protocol_version: EMBEDDED_PROTOCOL_VERSION, command }, this.#transport.config.max_request_bytes)) as { command: InputCommand };
    return freezeCallbackJson(envelope.command);
  }

  /**
   * Execute one short native command and recover copied delivery before any buffer-release failure propagates.
   * 执行一个短原生命令，在任何缓冲释放失败传播前恢复复制交付。
   * @param command Exact frozen command.
   * 精确冻结命令。
   * @param owner Optional mutation owner that retains uncertain native receipts.
   * 可选变更所有者，用于保留不确定原生回执。
   * @returns Actual delivered result; no mutation is repeated here.
   * 实际已交付结果；此处不重复任何变更。
   */
  private async execute(command: InputCommand, owner: { receipt: EmbeddedCommand | null } | null = null): Promise<EmbeddedJsonValue> {
    if (this.#needsRelease) throw new Error("Callback native result recovery is required");
    const receipt = this.#executor.submit(command, "control");
    if (owner !== null) owner.receipt = receipt;
    try {
      try { return await receipt.result(); }
      catch (error) {
        if (!(error instanceof EmbeddedResultReleaseError)) throw error;
        this.#needsRelease = true;
        this.fail(error);
        return receipt.deliveredResult();
      }
    } finally {
      if (owner === null && receipt.done) receipt.forget();
    }
  }

  /**
   * Dispatch one generated runtime command through the pump's reserved worker.
   * 通过泵预留工作线程分发一个生成的运行时命令。
   * @param operation Exact runtime operation discriminator and fields.
   * 精确运行时操作判别及字段。
   * @returns Generated result shape for this exact command.
   * 此精确命令的生成结果形状。
   */
  private async native<K extends RuntimeOperation["type"]>(operation: Extract<RuntimeOperation, { type: K }>): Promise<EmbeddedRuntimeResponseMap[K]["result"]> {
    return await this.execute({ type: "runtime", runtime_id: this.#runtimeId, operation }) as EmbeddedRuntimeResponseMap[K]["result"];
  }

  /** Own startup, serialization, callback scheduling and real worker drainage through all observers.
   * 跨全部观察者拥有启动、串行化、回调调度及真实工作线程排空。 */
  private async run(): Promise<void> {
    try {
      await this.#executor.ready();
      const initial = await this.execute({ type: "runtime_status", runtime_id: this.#runtimeId }) as OutputRuntimeSnapshot;
      if (initial.initialization !== "ready" || initial.closing) throw new Error("Callback pump requires an initialized open runtime");
      if (!this.#closing) { this.#ready = true; this.#started.resolve(); }
      else this.#started.reject(this.#failure ?? new Error("Callback pump closed before becoming ready"));
    } catch (error) { this.fail(error); this.#started.reject(error); }
    while (true) {
      this.#wake = completion();
      try {
        if (this.#retry !== null) {
          const attempt = this.#retry;
          try { await this.recover(); attempt.resolve(); } catch (error) { this.fail(error); attempt.reject(error); }
          this.#retry = null;
        }
        if (!this.nativePaused()) {
          const publication = [...this.#publications].find((entry) => !entry.attempted);
          if (publication !== undefined) await this.publish(publication);
          if (!this.nativePaused()) await this.drainAndPoll();
          if (!this.#closing && !this.nativePaused()) {
            const available = this.#config.maxConcurrentHandlers - this.#requests.size;
            if (available > 0) await this.take(available);
          }
        }
        if (this.#closing && !this.#registrations.size && !this.#requests.size && !this.#publications.size && !this.#tasks.size && this.#extraction === null && !this.#needsRelease && this.#retry === null) break;
        // A retained receipt must not hide a terminal worker failure behind indefinite recovery waits.
        // 保留的回执不能将工作线程终止故障隐藏在无限恢复等待之后。
        this.#executor.throwIfFailed();
      } catch (error) {
        this.fail(error);
        if (this.#executor.status.failure !== null) throw error;
      }
      await this.waitForWake();
    }
    await this.#executor.close();
    LIVE_PUMPS.delete(this);
    this.#closed = true;
    this.#stopped.resolve();
  }

  /** Await one advisory wake or bounded timer, always clearing the losing timer.
   * 等待一次参考唤醒或有界定时器，始终清理未获选的定时器。 */
  private async waitForWake(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = new Promise<void>((resolve) => { timer = setTimeout(resolve, this.#config.pollIntervalMs); });
    try { await Promise.race([tick, this.#wake.promise]); } finally { clearTimeout(timer); }
  }

  /**
   * Take one native batch while retaining the original receipt until every request has an owner.
   * 提取一个原生批次，同时保留原始回执，直到每个请求都有所有者。
   * @param limit Available callback slots, including retained acknowledgements in the used count.
   * 可用回调槽位，已用数量包括保留的待确认结果。
   * @returns Completion after installing all delivered requests without replaying the native take.
   * 安装全部已交付请求后完成，不重放原生提取。
   */
  private async take(limit: number): Promise<void> {
    if (this.#extraction !== null) throw new Error("Callback extraction requires explicit receipt recovery");
    const extraction = { receipt: null as EmbeddedCommand | null };
    this.#extraction = extraction;
    try {
      const requests = await this.execute({ type: "runtime", runtime_id: this.#runtimeId, operation: { type: "host_requests_take", limit } }, extraction) as OutputHostRequest[];
      this.deliver(requests);
      extraction.receipt?.forget();
      this.#extraction = null;
    } catch (error) {
      if (extraction.receipt === null || error instanceof EmbeddedRuntimeError || (error instanceof EmbeddedTransportError && error.functionName === "luaskills_ffi_embedded_request_v1" && error.status === EmbeddedNativeStatus.INVALID_ARGUMENT)) {
        extraction.receipt?.forget();
        this.#extraction = null;
      }
      throw error;
    }
  }

  /**
   * Publish one batch once, then install all exact owners before any callback intake.
   * 批次仅发布一次，然后在任何回调入场前安装全部精确所有者。
   * @param publication Retained accepted publication.
   * 保留的已接纳发布。
   */
  private async publish(publication: Publication): Promise<void> {
    publication.attempted = true;
    try {
      const result = await this.execute(publication.command, publication) as EmbeddedRuntimeResponseMap["capabilities_register"]["result"];
      this.install(publication, result.registration_ids);
    } catch (error) {
      publication.finished.reject(error);
      if (publication.receipt === null || error instanceof EmbeddedRuntimeError || (error instanceof EmbeddedTransportError && error.functionName === "luaskills_ffi_embedded_request_v1" && error.status === EmbeddedNativeStatus.INVALID_ARGUMENT)) {
        publication.receipt?.forget();
        this.#publications.delete(publication);
      } else this.fail(error);
    }
  }

  /**
   * Install only the exact batch identities from a proven native response.
   * 仅安装已证明原生响应中的精确批次身份。
   * @param publication Original immutable declarations and retained receipt.
   * 原始不可变声明及保留回执。
   * @param identities Actual core registration identities in order.
   * 按顺序返回的实际核心注册身份。
   */
  private install(publication: Publication, identities: string[]): void {
    if (!Array.isArray(identities) || identities.length !== publication.capabilities.length || new Set(identities).size !== identities.length || identities.some((id) => typeof id !== "string" || this.#registrations.has(id))) throw new Error("Core returned an inconsistent callback registration batch");
    for (let index = 0; index < identities.length; index += 1) {
      const id = identities[index]!;
      this.#registrations.set(id, { id, capability: publication.capabilities[index]!, retiring: false, retired: false, mutation: null, drained: completion() });
    }
    publication.identities = Object.freeze([...identities]);
    publication.receipt?.forget();
    this.#publications.delete(publication);
    publication.finished.resolve();
  }

  /**
   * Retain every delivered request before scheduling any application callback.
   * 在调度任何应用回调之前保留每个已交付请求。
   * @param requests Exact bounded batch already transferred by the core.
   * 核心已经转移的精确有界批次。
   */
  private deliver(requests: OutputHostRequest[]): void {
    const accepted: DeliveredRequest[] = [];
    for (const request of requests) {
      const record: DeliveredRequest = { request, registration: this.#registrations.get(request.registration_id) ?? null, context: null, outcome: null, command: null, acknowledgementFailed: false };
      this.#requests.set(request.request_id, record);
      accepted.push(record);
    }
    for (const record of accepted) {
      const task = Promise.resolve().then(() => HOST_CALLBACK_OWNER.run(this, () => this.handle(record)));
      this.#tasks.add(task);
      void task.then(() => { this.#tasks.delete(task); this.wake(); }, (error) => { this.#tasks.delete(task); this.fail(error); });
    }
  }

  /**
   * Execute one exact handler, seal explicit effects and freeze the resulting acknowledgement.
   * 执行一个精确处理器、封存显式副作用，并冻结所得确认。
   * @param record Owned delivered callback; its slot remains occupied until acknowledgement succeeds.
   * 拥有的已交付回调；其名额保留到确认成功。
   */
  private async handle(record: DeliveredRequest): Promise<void> {
    if (record.registration === null) {
      record.outcome = { ok: false, error: { code: "internal", message: "JavaScript callback registration owner is absent" }, effects: "not_started" };
      this.fail(new Error("Delivered callback has no exact JavaScript registration owner"));
    } else {
      const context = new HostCallbackContext(record.request, record.registration.capability.descriptor.effects);
      record.context = context;
      try {
        const value = await record.registration.capability.handler(record.request.arguments, context);
        record.outcome = { ok: true, value, effects: context.effects };
      } catch (error) {
        record.outcome = { ok: false, error: callbackFailure(error), effects: context.effects };
      } finally { context.seal(); }
    }
    try { record.command = this.completionCommand(record); }
    catch {
      record.outcome = { ok: false, error: { code: "execution_failed", message: "JavaScript host callback produced an invalid or oversized result" }, effects: record.outcome.effects };
      record.command = this.completionCommand(record);
    }
    // Keep only the frozen acknowledgement value after the real handler returns, not its mutable aliases.
    // 实际处理器返回后仅保留冻结确认值，不保留其可变别名。
    if (record.command.type !== "runtime" || record.command.operation.type !== "host_request_complete") throw new Error("Callback completion command invariant failed");
    record.outcome = record.command.operation.outcome;
    record.request.arguments = null;
    this.wake();
  }

  /**
   * Snapshot exact acknowledgement fields without exposing retained application aliases.
   * 复制精确确认字段，不暴露保留应用别名。
   * @param record Actual completed handler record.
   * 实际完成的处理器记录。
   * @returns Frozen complete native command, preserving explicit effects.
   * 保留显式副作用的冻结完整原生命令。
   */
  private completionCommand(record: DeliveredRequest): InputCommand {
    if (record.outcome === null) throw new Error("Cannot acknowledge a running callback");
    return this.freezeCommand({ type: "runtime", runtime_id: this.#runtimeId, operation: { type: "host_request_complete", request_id: record.request.request_id, outcome: record.outcome } });
  }

  /** Retire registrations, observe cancellation, acknowledge real returns and forget only proven drainage.
   * 退役注册、观察取消、确认真实返回，并仅遗忘已证明排空。 */
  private async drainAndPoll(): Promise<void> {
    for (const registration of this.#registrations.values()) {
      if (this.#closing) registration.retiring = true;
      if (registration.retiring && !registration.retired) {
        await this.mutateRegistration(registration, "capability_unregister");
        if (this.#needsRelease) return;
      }
    }
    for (const record of this.#requests.values()) {
      if (record.outcome === null) {
        const current = await this.native({ type: "host_request_status", request_id: record.request.request_id });
        if (current.cancellation !== null && record.context !== null) record.context.observeCancellation(current.cancellation);
      } else if (!record.acknowledgementFailed) await this.acknowledge(record);
      if (this.#needsRelease) return;
    }
    for (const registration of this.#registrations.values()) {
      if (!registration.retired) continue;
      const current = await this.native({ type: "capability_status", registration_id: registration.id });
      if (this.#needsRelease) return;
      if (current.drained && ![...this.#requests.values()].some((request) => request.registration === registration)) {
        await this.mutateRegistration(registration, "capability_forget");
        if (this.#needsRelease) return;
      }
    }
  }

  /**
   * Acknowledge only a real handler return, retaining failures until explicit evidence-based recovery.
   * 仅确认真实处理器返回，将失败保留到显式基于证据的恢复。
   * @param record Exact delivered owner with a frozen completion command.
   * 具有冻结完成命令的精确已交付所有者。
   */
  private async acknowledge(record: DeliveredRequest): Promise<void> {
    try {
      if (record.command === null) record.command = this.completionCommand(record);
      try { await this.execute(record.command); }
      catch (error) {
        if (!(error instanceof EmbeddedTransportError) || error.functionName !== "luaskills_ffi_embedded_request_v1" || error.status !== EmbeddedNativeStatus.INVALID_ARGUMENT) throw error;
        if (record.outcome === null) throw error;
        record.outcome = { ok: false, error: { code: "execution_failed", message: "JavaScript host callback result was rejected by the native parser" }, effects: record.outcome.effects };
        record.command = this.completionCommand(record);
        await this.execute(record.command);
      }
      this.#requests.delete(record.request.request_id);
    } catch (error) { record.acknowledgementFailed = true; this.fail(error); throw error; }
  }

  /** Recover original mutation and extraction receipts, then reconcile acknowledgements without rerunning handlers.
   * 恢复原始变更及提取回执，再核对确认，不重新运行处理器。 */
  private async recover(): Promise<void> {
    await this.#executor.releaseResults();
    this.#needsRelease = false;
    for (const publication of this.#publications) {
      if (!publication.attempted) continue;
      if (publication.receipt === null) throw new Error("Callback publication has no recoverable native receipt");
      const result = publication.receipt.deliveredResult() as EmbeddedRuntimeResponseMap["capabilities_register"]["result"];
      this.install(publication, result.registration_ids);
    }
    if (this.#extraction !== null) {
      const receipt = this.#extraction.receipt;
      if (receipt === null) throw new Error("Callback extraction has no recoverable native receipt");
      this.deliver(receipt.deliveredResult() as OutputHostRequest[]);
      receipt.forget();
      this.#extraction = null;
    }
    for (const registration of this.#registrations.values()) {
      const mutation = registration.mutation;
      if (mutation === null) continue;
      if (mutation.receipt === null) throw new Error("Callback registration mutation has no recoverable native receipt");
      if (mutation.receipt.deliveredResult() !== null) throw new Error("Callback registration mutation returned unexpected evidence");
      this.finishMutation(registration);
    }
    for (const record of this.#requests.values()) {
      if (record.outcome === null || !record.acknowledgementFailed) continue;
      let completed = false;
      try {
        const current = await this.native({ type: "host_request_status", request_id: record.request.request_id });
        if (current.phase === "completing") continue;
        completed = current.phase === "completed";
      } catch (error) {
        if (!(error instanceof EmbeddedRuntimeError) || (error.code !== "not_found" && error.code !== "already_completed")) throw error;
        const operation = await this.native({ type: "operation_status", operation_id: record.request.caller.operation_id });
        completed = operation.host_effects.some((effect) => effect.request_id === record.request.request_id && effect.registration_id === record.request.registration_id && effect.phase === "completed");
        if (!completed) throw new EmbeddedRuntimeError("not_found", "Callback completion evidence is unavailable; completion cannot be inferred");
      }
      if (completed) this.#requests.delete(record.request.request_id);
      else await this.acknowledge(record);
      if (this.#needsRelease) return;
    }
  }

  /** Pause ordinary native traffic while an owned extraction, publication or mutation has unconfirmed delivery.
   * 拥有型提取、发布或变更的交付尚未确认时，暂停普通原生流量。 */
  private nativePaused(): boolean {
    return this.#needsRelease || this.#extraction !== null || [...this.#publications].some((publication) => publication.attempted) || [...this.#registrations.values()].some((registration) => registration.mutation !== null);
  }

  /**
   * Attempt a registration mutation once and keep its exact receipt through uncertain failure.
   * 注册变更仅尝试一次，跨不确定失败保留精确回执。
   * @param registration Exact retained registration owner.
   * 精确保留注册所有者。
   * @param type Explicit unregister or metadata-forget operation.
   * 显式注销或元数据遗忘操作。
   */
  private async mutateRegistration(registration: Registration, type: "capability_unregister" | "capability_forget"): Promise<void> {
    if (registration.mutation !== null) throw new Error("Callback registration mutation requires explicit recovery");
    registration.mutation = { type, receipt: null };
    const result = await this.execute({ type: "runtime", runtime_id: this.#runtimeId, operation: { type, registration_id: registration.id } }, registration.mutation);
    if (result !== null) throw new Error("Callback registration mutation returned unexpected evidence");
    this.finishMutation(registration);
  }

  /**
   * Apply a proven native mutation exactly once, then release its retained local receipt.
   * 恰好一次应用已证明原生变更，然后释放保留本地回执。
   * @param registration Original registration with a proven pending mutation.
   * 具有已证明待处理变更的原始注册。
   */
  private finishMutation(registration: Registration): void {
    const mutation = registration.mutation;
    if (mutation === null || mutation.receipt === null) throw new Error("Callback registration mutation ownership is absent");
    if (mutation.type === "capability_unregister") registration.retired = true;
    else { this.#registrations.delete(registration.id); registration.drained.resolve(); }
    mutation.receipt.forget();
    registration.mutation = null;
  }
}
