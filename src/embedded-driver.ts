import { AsyncResource } from "node:async_hooks";
import { Worker } from "node:worker_threads";
import { types } from "node:util";
import { EMBEDDED_PROTOCOL_VERSION, type EmbeddedJsonValue, type InputCommand } from "./embedded-contract.js";
import { decodeEmbeddedJson, encodeEmbeddedJson } from "./embedded-json.js";
import { EmbeddedTransport, EmbeddedTransportError, EmbeddedResultReleaseError, decodeEmbeddedResponse } from "./embedded-transport.js";
import { EMBEDDED_CONTROL_WORKERS, type EmbeddedWorkerConfig, type EmbeddedWorkerError, type EmbeddedWorkerReply, type EmbeddedWorkerRequest } from "./embedded-worker-protocol.js";

/** Separate admission and execution lanes; the control worker never executes business-lane jobs.
 * 独立入场和执行通道；控制工作线程绝不执行业务通道任务。 */
export type EmbeddedCommandLane = "work" | "control";

/** Explicit bounds for workers and all retained command receipts, including completed receipts.
 * 工作线程及全部保留命令回执的显式上限，包含已完成回执。 */
export interface EmbeddedCommandDriverConfig {
  /** Fixed business worker count, independent from the reserved control worker.
   * 固定业务工作线程数量，独立于预留控制工作线程。 */
  readonly workThreads: number;
  /** Queued, running and completed-but-unforgotten business receipts.
   * 排队、运行中及已完成但尚未遗忘的业务回执。 */
  readonly maxWorkCommands: number;
  /** Queued, running and completed-but-unforgotten control receipts.
   * 排队、运行中及已完成但尚未遗忘的控制回执。 */
  readonly maxControlCommands: number;
}

/** Internal promise completion owner; external observers never receive its settle functions.
 * 内部 Promise 完成所有者；外部观察者绝不取得其完成函数。 */
interface Completion {
  /** Owned pending computation.
   * 拥有的待完成计算。 */
  readonly promise: Promise<void>;
  /** Publish actual completion.
   * 发布实际完成。 */
  readonly resolve: () => void;
  /** Publish an infrastructure failure without cancelling native work.
   * 发布基础设施失败，不取消原生工作。 */
  readonly reject: (error: unknown) => void;
}

/**
 * Allocate an owned completion and consume internal rejection notifications without hiding observer errors.
 * 分配拥有型完成对象并消费内部拒绝通知，同时保留观察者错误。
 * @returns One strongly retained promise and its private completion callbacks.
 * 一个强保留 Promise 及其私有完成回调。
 */
function completion(): Completion {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((accept, fail) => { resolve = accept; reject = fail; });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

/**
 * Observe a promise with independent cancellation; abort never settles or cancels the owned computation.
 * 以独立取消观察 Promise；中止绝不完成或取消拥有的计算。
 * @param pending Actual owned completion.
 * 实际拥有的完成对象。
 * @param signal Optional observer-only abort signal.
 * 可选且仅作用于观察者的中止信号。
 * @returns Observation of completion, or the signal's original rejection reason.
 * 完成观察，或信号的原始拒绝原因。
 */
async function observe(pending: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return pending;
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    void pending.then(() => { signal.removeEventListener("abort", abort); resolve(); }, (error) => { signal.removeEventListener("abort", abort); reject(error); });
    if (signal.aborted) abort();
  });
}

/**
 * Restore a worker's explicit evidence without treating its diagnostic text as a core business error.
 * 恢复工作线程显式证据，不将其诊断文本当作核心业务错误。
 * @param evidence Exact worker reply error.
 * 精确工作线程回复错误。
 * @returns Local SDK error retaining copied delivery bytes when available.
 * 本地 SDK 错误，在可用时保留已复制交付字节。
 */
function restoreError(evidence: EmbeddedWorkerError): Error {
  if (evidence.kind === "release") return new EmbeddedResultReleaseError(evidence.status, evidence.responseBytes === null ? null : Buffer.from(evidence.responseBytes), new Error(evidence.message));
  if (evidence.kind === "transport") return new EmbeddedTransportError(evidence.functionName, evidence.status);
  return new Error(evidence.message);
}

/** One actual command's retained state, kept independently of all result observers.
 * 一个实际命令的保留状态，独立于所有结果观察者保存。 */
interface CommandState {
  /** Exact local monotonically increasing receipt identity.
   * 精确本地单调递增回执身份。 */
  readonly id: string;
  /** Original declared lane.
   * 原始声明通道。 */
  readonly lane: EmbeddedCommandLane;
  /** Frozen request bytes owned until actual completion.
   * 拥有到实际完成为止的冻结请求字节。 */
  bytes: Uint8Array;
  /** Actual copied response, independent of observation and native allocation.
   * 实际复制响应，独立于观察和原生分配。 */
  response: Uint8Array | null;
  /** Transport or infrastructure failure; business errors are decoded from the response.
   * 传输或基础设施失败；业务错误从响应解码。
   */
  error: Error | null;
  /** True only after an actual reply or terminal infrastructure failure is recorded.
   * 仅在记录实际回复或终态基础设施失败后为真。 */
  done: boolean;
  /** Exact SDK completion owner.
   * 精确 SDK 完成所有者。 */
  readonly completion: Completion;
  /** Diagnostic async context owned until execution finishes.
   * 拥有到执行结束的诊断异步上下文。 */
  readonly resource: AsyncResource;
  /** Public receipt identity used for exact forgetting checks.
   * 用于精确遗忘校验的公开回执身份。 */
  receipt: EmbeddedCommand;
}

/** Retained command receipt; cancelling result observation never cancels its actual native execution.
 * 保留命令回执；取消结果观察绝不取消实际原生执行。 */
export class EmbeddedCommand {
  // Private state and forget callback cannot be altered through public JavaScript property aliases.
  // 私有状态及遗忘回调不能经公开 JavaScript 属性别名修改。
  readonly #state: CommandState;
  readonly #forget: () => void;

  /**
   * Bind a receipt to driver-owned state; direct callers should obtain receipts from submit.
   * 将回执绑定到驱动拥有状态；直接调用方应通过 submit 取得回执。
   * @param state Exact retained command state.
   * 精确保留命令状态。
   * @param forget Exact owner-checked quota return callback.
   * 经精确所有者校验的配额归还回调。
   * @internal
   */
  constructor(state: CommandState, forget: () => void) { this.#state = state; this.#forget = forget; Object.freeze(this); }

  /** Exact local command identity; distinct from every core runtime/operation identity.
   * 精确本地命令身份；独立于所有核心运行时／操作身份。 */
  get id(): string { return this.#state.id; }
  /** Original declared command lane.
   * 原始声明命令通道。 */
  get lane(): EmbeddedCommandLane { return this.#state.lane; }
  /** Actual receipt completion, independent of observer abort.
   * 实际回执完成状态，独立于观察者中止。 */
  get done(): boolean { return this.#state.done; }
  /** Return a fresh copied response or null when no delivery evidence is available.
   * 返回新的响应副本；无交付证据时为 null。 */
  get responseBytes(): Uint8Array | null { return this.#state.response === null ? null : Uint8Array.from(this.#state.response); }

  /**
   * Observe the actual command result without cancelling its work when signal aborts.
   * 观察实际命令结果；signal 中止时不取消其工作。
   * @param options Optional observer cancellation.
   * 可选观察者取消。
   * @returns Fresh decoded result; throws retained transport or delivered core errors.
   * 新解码结果；抛出保留传输错误或已交付核心错误。
   */
  async result(options: { signal?: AbortSignal } = {}): Promise<EmbeddedJsonValue> {
    await observe(this.#state.completion.promise, options.signal);
    if (this.#state.error) throw this.#state.error;
    return this.deliveredResult();
  }

  /** Decode original copied evidence without dispatching any C call, including after release failure.
   * 不分发任何 C 调用而解码原有复制证据，包含释放失败后的证据。 */
  deliveredResult(): EmbeddedJsonValue {
    if (!this.#state.done || this.#state.response === null) throw new Error("Embedded command has no completed copied response");
    return decodeEmbeddedResponse(this.#state.response);
  }

  /** Return only this completed SDK receipt quota; this does not forget a core operation or runtime.
   * 仅归还此已完成 SDK 回执配额；不会遗忘核心操作或运行时。 */
  forget(): void { this.#forget(); }
}

/** Private lifecycle for one fixed serial worker; only confirmed stop plus exit proves safe release.
 * 一个固定串行工作线程的私有生命周期；仅确认停止加退出才证明可安全释放。 */
interface WorkerSlot {
  /** Actual Node worker retained until its exit event.
   * 保留到退出事件的实际 Node 工作线程。 */
  readonly worker: Worker;
  /** Fixed lane assigned at construction.
   * 构造时分配的固定通道。 */
  readonly lane: EmbeddedCommandLane;
  /** Current local message protocol phase.
   * 当前本地消息协议阶段。 */
  phase: "starting" | "idle" | "busy" | "retained" | "releasing" | "stopping" | "exited";
  /** Exact native command currently occupying the worker.
   * 当前占有工作线程的精确原生命令。 */
  command: CommandState | null;
  /** Explicit retained-result recovery owned independently from command quotas.
   * 独立于命令配额拥有的显式保留结果恢复。 */
  recovery: { id: string; completion: Completion } | null;
  /** Confirmed worker stop message before the actual exit event.
   * 实际退出事件之前确认的工作线程停止消息。 */
  stopped: boolean;
  /** Whether any native command has ever been sent to this worker.
   * 是否曾向此工作线程发送任何原生命令。 */
  used: boolean;
  /** Startup failure proves that the worker never accepted native commands.
   * 启动失败证明工作线程从未接纳原生命令。 */
  startupFailed: boolean;
}

// A driver and its transport claim survive discarded application references and aborted observers.
// 驱动及其传输声明跨应用引用丢弃和观察者中止继续存活。
const LIVE_DRIVERS = new Set<EmbeddedCommandDriver>();

// One field authority governs strict data-only driver configuration.
// 唯一字段权威约束严格的纯数据驱动配置。
const CONFIG_FIELDS = ["workThreads", "maxWorkCommands", "maxControlCommands"] as const;

/** Bounded fixed-worker command driver with independent work/control queues and retained receipts.
 * 具有独立业务／控制队列和保留回执的有界固定工作线程命令驱动。 */
export class EmbeddedCommandDriver {
  /** Retain discoverable driver owners after discarded references or observer cancellation.
   * 丢弃引用或取消观察后，仍保留可发现的驱动所有者。 */
  static get live(): readonly EmbeddedCommandDriver[] { return Object.freeze([...LIVE_DRIVERS]); }
  // Borrowed owner and frozen local admission limits.
  // 借用所有者及冻结本地入场限制。
  private readonly transport: EmbeddedTransport;
  private readonly limits: Readonly<EmbeddedCommandDriverConfig>;
  // All actual worker handles, command owners and FIFO queues remain coordinator-owned.
  // 全部实际工作线程句柄、命令所有者和先进先出队列均由协调器拥有。
  private readonly workers: WorkerSlot[] = [];
  private readonly retained = new Map<string, CommandState>();
  private readonly queues: Record<EmbeddedCommandLane, CommandState[]> = { work: [], control: [] };
  private readonly counts: Record<EmbeddedCommandLane, number> = { work: 0, control: 0 };
  // Startup and close completion have independent observers and cannot be cancelled by them.
  // 启动及关闭完成拥有独立观察者，不能被观察者取消。
  private readonly started = completion();
  private readonly stopped = completion();
  private sequence = 0n;
  private readyState = false;
  private closing = false;
  private closed = false;
  private failure: Error | null = null;
  private unsafeExit = false;

  /**
   * Claim native frame capacity and start fixed workers without issuing any native business command.
   * 声明原生帧容量并启动固定工作线程，不发出任何原生业务命令。
   * @param transport Existing live transport borrowed until actual worker shutdown.
   * 借用到实际工作线程关闭为止的现有活动传输。
   * @param config Explicit worker and retained-receipt limits.
   * 显式工作线程及保留回执限制。
   */
  constructor(transport: EmbeddedTransport, config: EmbeddedCommandDriverConfig) {
    if (config === null || typeof config !== "object" || types.isProxy(config)) throw new TypeError("Embedded driver requires exactly three data limits");
    const descriptors = Object.getOwnPropertyDescriptors(config);
    if (Reflect.ownKeys(descriptors).length !== CONFIG_FIELDS.length || CONFIG_FIELDS.some((key) => !Object.hasOwn(descriptors, key) || !("value" in descriptors[key]))) throw new TypeError("Embedded driver requires exactly three data limits");
    const normalized = {} as Record<keyof EmbeddedCommandDriverConfig, number>;
    for (const key of CONFIG_FIELDS) {
      const value: unknown = descriptors[key].value;
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${key} must be a positive safe integer`);
      normalized[key] = value;
    }
    if (normalized.workThreads > normalized.maxWorkCommands) throw new RangeError("workThreads exceeds maxWorkCommands");
    this.transport = transport;
    this.limits = Object.freeze(normalized);
    const identity = transport.claimDriver(this, this.limits.workThreads + EMBEDDED_CONTROL_WORKERS);
    LIVE_DRIVERS.add(this);
    const workerData: EmbeddedWorkerConfig = { libraryPath: transport.libraryPath, transportId: identity, maxRequestBytes: transport.config.max_request_bytes, maxResponseBytes: transport.config.max_response_bytes };
    try {
      for (let index = 0; index < this.limits.workThreads + EMBEDDED_CONTROL_WORKERS; index += 1) {
        // Packaged worker code has no application preload hooks and never receives shared Buffer pool storage.
        // 包内工作线程代码不加载应用预载钩子，且绝不接收共享 Buffer 池存储。
        const worker = new Worker(new URL("./embedded-worker.js", import.meta.url), { workerData, execArgv: [] });
        const slot: WorkerSlot = { worker, lane: index < this.limits.workThreads ? "work" : "control", phase: "starting", command: null, recovery: null, stopped: false, used: false, startupFailed: false };
        this.workers.push(slot);
        worker.on("message", (reply: EmbeddedWorkerReply) => { try { this.onMessage(slot, reply); } catch (error) { this.unsafeExit = true; this.fail(error); } });
        worker.on("error", (error) => this.fail(error));
        worker.on("messageerror", (error) => { this.unsafeExit = true; this.fail(error); });
        worker.once("exit", (code) => this.onExit(slot, code));
      }
    } catch (error) { this.fail(error); }
    this.advanceClose();
  }

  /** Return a frozen snapshot of all retained receipts, including completed and failed commands.
   * 返回全部保留回执的冻结快照，包含已完成及失败命令。 */
  get commands(): readonly EmbeddedCommand[] { return Object.freeze([...this.retained.values()].map((state) => state.receipt)); }
  /** Return real coordinator state, never an inferred core runtime or operation phase.
   * 返回真实协调器状态，绝不推断核心运行时或操作阶段。 */
  get status(): Readonly<{ ready: boolean; closing: boolean; closed: boolean; workers: number; queued: number; running: number; retainedResults: number; failure: string | null }> {
    return Object.freeze({ ready: this.readyState, closing: this.closing, closed: this.closed, workers: this.workers.filter((slot) => slot.phase !== "exited").length, queued: this.queues.work.length + this.queues.control.length, running: this.workers.filter((slot) => slot.command !== null).length, retainedResults: this.workers.filter((slot) => slot.phase === "retained" || slot.phase === "releasing").length, failure: this.failure?.message ?? null });
  }

  /** Await worker binding readiness; signal cancels only this observer.
   * 等待工作线程绑定就绪；signal 仅取消此观察者。 */
  ready(options: { signal?: AbortSignal } = {}): Promise<void> { return observe(this.started.promise, options.signal); }

  /**
   * Freeze a command and publish its receipt before dispatch to the declared lane.
   * 冻结命令并在分发到声明通道前发布其回执。
   * @param command Exact generated command; blocking operation_wait is intentionally rejected.
   * 精确生成命令；明确拒绝阻塞式 operation_wait。
   * @param lane Independent work or control admission quota.
   * 独立业务或控制入场配额。
   * @returns Retained observable receipt, even when observers later abort.
   * 保留的可观察回执，即使观察者随后中止也保留。
   */
  submit(command: InputCommand, lane: EmbeddedCommandLane = "work"): EmbeddedCommand {
    if (!this.readyState || this.closing || this.failure) throw new Error("Embedded command driver is not accepting commands");
    if (lane !== "work" && lane !== "control") throw new TypeError("Unknown embedded command lane");
    const limit = lane === "work" ? this.limits.maxWorkCommands : this.limits.maxControlCommands;
    if (this.counts[lane] >= limit) throw new RangeError(`Embedded ${lane} command receipt capacity exceeded`);
    const bytes = Uint8Array.from(encodeEmbeddedJson({ protocol_version: EMBEDDED_PROTOCOL_VERSION, command }, this.transport.config.max_request_bytes));
    // Inspect only copied JSON data, never application accessors before the strict encoder rejects them.
    // 仅检查复制后的 JSON 数据，绝不在严格编码器拒绝之前读取应用访问器。
    const snapshot = decodeEmbeddedJson(bytes) as { command: InputCommand };
    if (snapshot.command.type === "runtime" && snapshot.command.operation.type === "operation_wait") throw new Error("Blocking operation_wait is not supported by the command driver; poll operation_status");
    const resource = new AsyncResource("LuaSkillsEmbeddedCommand", { requireManualDestroy: true });
    // Async hooks may reenter admission or close; recheck ownership immediately before publishing.
    // 异步钩子可能重入入场或关闭；发布之前立即重新检查所有权。
    if (!this.readyState || this.closing || this.failure || this.counts[lane] >= limit) {
      resource.emitDestroy();
      throw new Error("Embedded command admission changed during async resource initialization");
    }
    const state = { id: String(++this.sequence), lane, bytes, response: null, error: null, done: false, completion: completion(), resource } as CommandState;
    state.receipt = new EmbeddedCommand(state, () => this.forget(state));
    this.retained.set(state.id, state);
    this.counts[lane] += 1;
    this.queues[lane].push(state);
    this.dispatch();
    return state.receipt;
  }

  /**
   * Recover only exact worker-owned result allocations, without consuming command receipt capacity.
   * 仅恢复精确工作线程拥有的结果分配，不消耗命令回执容量。
   * @returns Completion of all currently retained release attempts; never replays business requests.
   * 当前全部保留释放尝试的完成；绝不重放业务请求。
   */
  async releaseResults(): Promise<void> {
    if (this.failure) throw this.failure;
    const pending: Promise<void>[] = [];
    for (const slot of this.workers) {
      if (slot.recovery) { pending.push(slot.recovery.completion.promise); continue; }
      if (slot.phase !== "retained") continue;
      const recovery = { id: `release-${++this.sequence}`, completion: completion() };
      slot.recovery = recovery;
      slot.phase = "releasing";
      pending.push(recovery.completion.promise);
      try { this.send(slot, { type: "release", id: recovery.id }); }
      catch (error) { this.unsafeExit = true; recovery.completion.reject(error); this.fail(error); }
    }
    await Promise.all(pending);
  }

  /**
   * Fence new admission, finish queued work and await confirmed stop plus actual exit for every worker.
   * 封闭新入场、完成排队工作，并等待每个工作线程确认停止及实际退出。
   * @param options Optional observer cancellation; native work and the close coordinator remain alive.
   * 可选观察者取消；原生工作及关闭协调器继续存活。
   * @returns Actual driver closure; this does not close its borrowed core transport or runtimes.
   * 实际驱动关闭；不会关闭借用的核心传输或运行时。
   */
  close(options: { signal?: AbortSignal } = {}): Promise<void> {
    this.closing = true;
    if (!this.readyState) this.started.reject(new Error("Embedded command driver closed before becoming ready"));
    this.dispatch();
    this.advanceClose();
    return observe(this.stopped.promise, options.signal);
  }

  /** Return a completed receipt's exact quota; stale or running owners cannot be forgotten.
   * 归还已完成回执的精确配额；过期或运行中所有者不可遗忘。 */
  private forget(state: CommandState): void {
    if (!state.done || this.retained.get(state.id) !== state) throw new Error("Only an exact retained completed command can be forgotten");
    this.retained.delete(state.id);
    this.counts[state.lane] -= 1;
  }

  /** Post one already validated protocol frame without transferring or detaching retained evidence.
   * 发布一个已经校验的协议帧，不转移或分离保留证据。 */
  private send(slot: WorkerSlot, message: EmbeddedWorkerRequest): void { slot.worker.postMessage(message); }

  /** Fill only idle workers from their fixed FIFO lane, preserving independent control capacity.
   * 仅从固定先进先出通道填充空闲工作线程，保留独立控制容量。 */
  private dispatch(): void {
    if (!this.readyState || this.failure) return;
    for (const slot of this.workers) {
      if (slot.phase !== "idle") continue;
      const command = this.queues[slot.lane].shift();
      if (!command) continue;
      slot.command = command;
      slot.phase = "busy";
      slot.used = true;
      try { this.send(slot, { type: "request", id: command.id, bytes: command.bytes }); }
      catch (error) {
        this.unsafeExit = true;
        this.fail(error);
      }
    }
  }

  /** Publish real completion while retaining copied bytes and caller-visible diagnostics.
   * 发布真实完成，同时保留复制字节和调用方可见诊断。 */
  private finish(state: CommandState, response: Uint8Array | null, error: Error | null): void {
    if (state.done) throw new Error("Embedded command completed more than once");
    state.response = response === null ? null : Uint8Array.from(response);
    state.error = error;
    state.done = true;
    state.bytes = new Uint8Array();
    state.resource.runInAsyncScope(state.completion.resolve);
    state.resource.emitDestroy();
  }

  /** Validate worker identity/phase transitions before accepting readiness, completion or release evidence.
   * 在接纳就绪、完成或释放证据之前校验工作线程身份及阶段转换。 */
  private onMessage(slot: WorkerSlot, reply: EmbeddedWorkerReply): void {
    switch (reply.type) {
      case "ready":
        if (slot.phase !== "starting") throw new Error("Unexpected embedded worker ready");
        slot.phase = "idle";
        if (!this.closing && !this.failure && this.workers.every((worker) => worker.phase === "idle")) { this.readyState = true; this.started.resolve(); }
        break;
      case "startup_failed":
        if (slot.used || slot.phase !== "starting") throw new Error("Unexpected embedded startup failure");
        slot.startupFailed = true;
        this.fail(restoreError(reply.error));
        break;
      case "completed": {
        const command = slot.command;
        if (slot.phase !== "busy" || !command || command.id !== reply.id) throw new Error("Embedded completion identity mismatch");
        const error = reply.error === null ? null : restoreError(reply.error);
        const response = reply.error?.kind === "release" ? reply.error.responseBytes : reply.bytes;
        this.finish(command, response, error);
        slot.command = null;
        slot.phase = reply.retained ? "retained" : "idle";
        break;
      }
      case "released": {
        const recovery = slot.recovery;
        if (slot.phase !== "releasing" || !recovery || recovery.id !== reply.id) throw new Error("Embedded release identity mismatch");
        slot.recovery = null;
        slot.phase = reply.retained ? "retained" : "idle";
        if (reply.error) recovery.completion.reject(restoreError(reply.error));
        else if (reply.retained) {
          const error = new Error("Embedded release reported success while retaining a result");
          recovery.completion.reject(error);
          throw error;
        }
        else recovery.completion.resolve();
        break;
      }
      case "stopped":
        if (slot.phase !== "stopping" || slot.command || slot.recovery || slot.stopped) throw new Error("Unexpected embedded worker stop proof");
        slot.stopped = true;
        break;
      default: throw new Error("Unknown embedded worker reply");
    }
    this.dispatch();
    this.advanceClose();
  }

  /** Process actual worker exit only after all preceding messages have been observed.
   * 仅在观察到全部先行消息后处理实际工作线程退出。 */
  private onExit(slot: WorkerSlot, code: number): void {
    const safe = (!slot.used && (slot.startupFailed || this.failure !== null)) || (code === 0 && slot.phase === "stopping" && slot.stopped);
    if (!safe) { this.unsafeExit = true; this.fail(new Error(`Embedded worker exited without drainage proof (code ${code})`)); }
    if (slot.command) { if (!slot.command.done) this.finish(slot.command, null, this.failure ?? new Error("Embedded worker exited during a command")); slot.command = null; }
    if (slot.recovery) { slot.recovery.completion.reject(this.failure ?? new Error("Embedded worker exited during result recovery")); slot.recovery = null; }
    slot.phase = "exited";
    this.advanceClose();
  }

  /** Fence failures, retain uncertain native ownership and fail only commands never dispatched.
   * 封闭失败、保留不确定原生所有权，并仅直接失败从未分发的命令。 */
  private fail(reason: unknown): void {
    if (this.failure === null) this.failure = reason instanceof Error ? reason : new Error(String(reason));
    this.closing = true;
    this.started.reject(this.failure);
    for (const lane of ["work", "control"] as const) {
      for (const command of this.queues[lane].splice(0)) this.finish(command, null, this.failure);
    }
    if (this.unsafeExit) {
      // Reject observers without declaring native work complete or discarding late delivery evidence.
      // 拒绝观察者，但不宣称原生工作完成，也不丢弃迟到交付证据。
      for (const slot of this.workers) {
        slot.command?.completion.reject(this.failure);
        slot.recovery?.completion.reject(this.failure);
      }
      this.stopped.reject(this.failure);
    }
    this.advanceClose();
  }

  /** Stop drained workers cooperatively and release the claim only after every confirmed safe exit.
   * 协作停止已排空工作线程，仅在每个线程确认安全退出后释放声明。 */
  private advanceClose(): void {
    if (!this.closing || this.closed) return;
    for (const slot of this.workers) {
      if (slot.phase === "idle" && !this.queues[slot.lane].length) {
        slot.phase = "stopping";
        try { this.send(slot, { type: "stop" }); }
        catch (error) { this.unsafeExit = true; this.fail(error); }
      }
    }
    if (!this.unsafeExit && this.workers.every((slot) => slot.phase === "exited")) {
      this.transport.releaseDriver(this);
      LIVE_DRIVERS.delete(this);
      this.closed = true;
      this.stopped.resolve();
    }
  }
}
