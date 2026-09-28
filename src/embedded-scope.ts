import { EmbeddedNativeStatus, type EmbeddedJsonValue, type OutputRuntimeSnapshot, type OutputInitializationPhase } from "./embedded-contract.js";
import { EmbeddedRuntime } from "./embedded-client.js";
import { EmbeddedCommand, EmbeddedScopeExecutor } from "./embedded-driver.js";
import { EmbeddedCallbackPump } from "./embedded-pump.js";
import { EmbeddedResultReleaseError, EmbeddedRuntimeError, EmbeddedTransportError } from "./embedded-transport.js";
import { EMBEDDED_POLL_INTERVAL_MS, checkEmbeddedCallbackWait, completion, observe, pauseEmbeddedPoll, validateEmbeddedPollInterval, type Completion } from "./embedded-observation.js";

/** Proven shutdown checkpoints; a failed observation never advances native ownership.
 * 已获证明的关闭检查点；观察失败绝不推进原生所有权。 */
type ScopePhase = "open" | "closing_runtime" | "draining_callbacks" | "draining_runtime" | "releasing_runtime" | "released" | "closed" | "startup_failed";
/** Only these root controls have pre-encoded mutation receipts or read-only semantics.
 * 仅这些根控制拥有预编码变更回执或只读语义。 */
type ScopeControl = "runtime_close" | "runtime_status" | "runtime_free";
/** Keep the exact submitted command until delivery and result-buffer ownership are resolved.
 * 保留精确提交命令，直到交付及结果缓冲所有权解决。 */
interface PendingControl {
  /** Original root command type.
   * 原始根命令类型。 */
  readonly type: ScopeControl;
  /** Exact original receipt; recovery never replaces it with a resubmitted mutation.
   * 精确原始回执；恢复绝不以重新提交的变更替换。 */
  readonly receipt: EmbeddedCommand;
  /** Whether successful copied evidence has already advanced its checkpoint.
   * 成功复制证据是否已推进其检查点。 */
  consumed: boolean;
}

// Strong ownership survives discarded references and observer cancellation.
// 强所有权跨越引用丢弃及观察取消保留。
const LIVE_SCOPES = new Set<EmbeddedRuntimeScope>();

// Exhaustiveness against the generated type makes a new initialization state require an explicit lifecycle review.
// 生成类型的穷尽检查要求新增初始化状态接受显式生命周期审核。
const INITIALIZATION_PHASES = { reserved: true, initializing: true, ready: true, failed: true, faulted: true } satisfies Record<OutputInitializationPhase, boolean>;

/**
 * Own one exact runtime and optional callback pump while borrowing the shared driver and transport.
 * 拥有一个精确运行时及可选回调泵，同时借用共享驱动器及传输。
 * Closure waits for callback completion, core drainage, slot removal and actual scope-worker exit.
 * 关闭等待回调完成、核心排空、槽移除及作用域线程实际退出。
 */
export class EmbeddedRuntimeScope {
  // Exact immutable adopted handles and the independent control worker.
  // 接管的精确不可变句柄及独立控制线程。
  readonly #runtime: EmbeddedRuntime;
  readonly #pump: EmbeddedCallbackPump | null;
  readonly #executor: EmbeddedScopeExecutor;
  readonly #pollIntervalMs: number;
  // Startup owns unused-worker cleanup; shutdown attempts remain independent of their observers.
  // 启动拥有未使用线程清理；关闭尝试独立于其观察者。
  readonly #startup: Promise<void>;
  #phase: ScopePhase = "open";
  #attempt: Completion | null = null;
  #running = false;
  #failure: Error | null = null;
  #pending: PendingControl | null = null;
  #needsRelease = false;
  #retryable = false;

  /**
   * Adopt runtime and its existing pump before initialization or closure; allocate no native runtime.
   * 在初始化或关闭前接管 runtime 及其已有泵；不分配原生运行时。
   * @param runtime Exact reserved or initialized runtime handle from the borrowed client.
   * 借用客户端提供的精确已预留或已初始化运行时句柄。
   * @param options Existing pump, if any, and a validated positive polling interval.
   * 已有泵（如存在）及已校验的正数轮询间隔。
   */
  constructor(runtime: EmbeddedRuntime, options: { pump?: EmbeddedCallbackPump; pollIntervalMs?: number } = {}) {
    checkEmbeddedCallbackWait();
    const interval = options.pollIntervalMs ?? EMBEDDED_POLL_INTERVAL_MS;
    validateEmbeddedPollInterval(interval);
    const transport = runtime.client.driver.borrowedTransport;
    const pump = options.pump ?? null;
    const owner = pump === null ? null : pump.scopeOwner(transport, runtime.runtimeId);
    this.#runtime = runtime;
    this.#pump = pump;
    this.#pollIntervalMs = interval;
    this.#executor = new EmbeddedScopeExecutor(transport, runtime.runtimeId, owner);
    LIVE_SCOPES.add(this);
    this.#startup = this.start();
    void this.#startup.catch(() => {});
    Object.freeze(this);
  }

  /** Return strongly retained scopes whose native ownership has not been safely discharged.
   * 返回原生所有权尚未安全解除且被强引用保留的作用域。 */
  static get live(): readonly EmbeddedRuntimeScope[] { return Object.freeze([...LIVE_SCOPES]); }
  /** Return the exact adopted runtime; this getter makes no native call.
   * 返回精确接管的运行时；此读取不进行原生调用。 */
  get runtime(): EmbeddedRuntime { return this.#runtime; }
  /** Return a frozen checkpoint snapshot; closed requires both slot removal and worker exit.
   * 返回冻结检查点快照；closed 要求槽移除及线程退出均完成。 */
  get status(): Readonly<{ phase: ScopePhase; failure: string | null; retryable: boolean; needsResultRelease: boolean; pendingCommand: ScopeControl | null }> {
    return Object.freeze({ phase: this.#phase, failure: this.#failure?.message ?? null, retryable: this.#retryable, needsResultRelease: this.#needsRelease, pendingCommand: this.#pending?.type ?? null });
  }

  /** Observe the independent worker becoming ready; signal cancels only this observer, returning no runtime readiness proof.
   * 观察独立线程就绪；signal 仅取消此观察者，不返回运行时就绪证明。 */
  ready(options: { signal?: AbortSignal } = {}): Promise<void> {
    checkEmbeddedCallbackWait();
    return observe(this.#startup, options.signal);
  }

  /**
   * Start or observe the same owned shutdown attempt; repeated calls never replay failed mutations.
   * 启动或观察同一拥有型关闭尝试；重复调用绝不重放失败变更。
   * @param options Optional cancellation of this observer only, including already-aborted signals.
   * 仅对此观察者生效的可选取消，包括已中止信号。
   * @returns Completion after actual native and worker release, or the exact observed error.
   * 实际原生及线程释放后的完成，或精确观察错误。
   */
  close(options: { signal?: AbortSignal } = {}): Promise<void> {
    checkEmbeddedCallbackWait();
    return observe(this.request(false), options.signal);
  }

  /**
   * Explicitly recover original receipts, retained buffers or proven root capacity rejection.
   * 显式恢复原始回执、保留缓冲或已获证明的根容量拒绝。
   * @param options Optional observer cancellation, never coordinator cancellation.
   * 可选观察取消，绝不取消协调器。
   * @returns Completion of the shared current attempt; unsafe retry requests reject without mutation.
   * 当前共享尝试的完成；不安全重试请求在变更前拒绝。
   */
  retryClose(options: { signal?: AbortSignal } = {}): Promise<void> {
    checkEmbeddedCallbackWait();
    return observe(this.request(true), options.signal);
  }

  /** Await actual shutdown when used with JavaScript asynchronous resource management.
   * 用于 JavaScript 异步资源管理时等待实际关闭。
   * @returns The same owned shutdown completion as close().
   * 与 close() 相同的拥有型关闭完成。 */
  [Symbol.asyncDispose](): Promise<void> { return this.close(); }

  /** Prove unused startup cleanup on failure; return when the independent executor is ready.
   * 失败时证明未使用启动清理；独立执行器就绪后返回。 */
  private async start(): Promise<void> {
    try { await this.#executor.ready(); }
    catch (error) {
      this.#failure = error instanceof Error ? error : new Error(String(error));
      await this.#executor.close();
      this.#executor.releaseOwnership();
      LIVE_SCOPES.delete(this);
      this.#phase = "startup_failed";
      throw error;
    }
  }

  /** Select or create an attempt; retry permits only retained evidence recovery or proven non-mutation.
   * 选择或创建尝试；retry 仅允许保留证据恢复或已证明未变更的情形。
   * @returns Owned completion independent of all observers.
   * 独立于全部观察者的拥有型完成。 */
  private request(retry: boolean): Promise<void> {
    if (this.#attempt !== null && (!retry || this.#running || this.#phase === "closed")) return this.#attempt.promise;
    if (this.#attempt !== null && !this.#retryable) throw new Error("Runtime scope failure lacks evidence for safe recovery", { cause: this.#failure });
    const attempt = completion();
    this.#attempt = attempt;
    this.#running = true;
    this.#failure = null;
    this.#retryable = false;
    void this.drain(retry).then(() => {
      this.#running = false;
      attempt.resolve();
    }, (error: unknown) => {
      this.#running = false;
      this.#failure = error instanceof Error ? error : new Error(String(error));
      const capacityRejected = error instanceof EmbeddedTransportError && error.functionName === "luaskills_ffi_embedded_request_v1" && error.status === EmbeddedNativeStatus.CAPACITY_EXCEEDED;
      this.#retryable = this.#phase !== "startup_failed" && this.#executor.status.failure === null
        && (this.#needsRelease || this.#pending !== null || capacityRejected || ((this.#phase === "draining_callbacks" || this.#phase === "draining_runtime") && this.#pump !== null && this.#pump.recoveryRequired));
      attempt.reject(error);
    });
    return attempt.promise;
  }

  /** Forget a proven delivery's SDK receipt, leaving native runtime lifetime to the checkpoint.
   * 遗忘已证明交付的 SDK 回执，原生运行时生命周期由检查点决定。 */
  private clearPending(): void {
    if (this.#pending === null) return;
    this.#pending.receipt.forget();
    this.#pending = null;
  }

  /**
   * Check the exact slot identity and the status fields consumed by lifecycle checkpoints.
   * 检查生命周期检查点使用的精确槽身份及状态字段。
   * @param type Original control command whose response is being consumed.
   * 正在消费响应的原始控制命令。
   * @param value Copied native result; validation never issues or replays a command.
   * 已复制的原生结果；校验绝不发出或重放命令。
   * @returns Nothing; malformed evidence throws before ownership can advance.
   * 无返回值；畸形证据在所有权推进前抛错。
   */
  private validateControl(type: ScopeControl, value: EmbeddedJsonValue): void {
    if (value === null || typeof value !== "object" || Array.isArray(value) || !("runtime_id" in value)
      || value.runtime_id !== this.#runtime.runtimeId) throw new Error("Runtime scope control response changed its exact slot identity");
    if (type === "runtime_status" && (!("closed" in value) || typeof value.closed !== "boolean"
      || !("initialization" in value) || typeof value.initialization !== "string" || !Object.hasOwn(INITIALIZATION_PHASES, value.initialization))) {
      throw new Error("Runtime scope control response has invalid lifecycle evidence");
    }
  }

  /**
   * Deliver one root control or recover its exact copied response, then apply its proven checkpoint.
   * 交付一个根控制或恢复其精确复制响应，再应用已证明检查点。
   * @param type Restricted lifecycle control with known root encoding semantics.
   * 具有已知根编码语义的受限生命周期控制。
   * @param accept Synchronous projection/checkpoint applied only on successful delivery.
   * 仅在成功交付后应用的同步投影／检查点。
   * @returns After delivery; buffer-release failures still reject after checkpoint publication.
   * 交付后返回；缓冲释放失败仍在发布检查点后拒绝。
   */
  private async control(type: ScopeControl, accept: (value: EmbeddedJsonValue) => void): Promise<void> {
    const recovering = this.#pending !== null;
    if (this.#pending === null) this.#pending = { type, receipt: this.#executor.submit({ type, runtime_id: this.#runtime.runtimeId }, "control"), consumed: false };
    const pending = this.#pending;
    if (pending.type !== type) throw new Error("Runtime scope checkpoint does not match its retained control receipt");
    try {
      let value: EmbeddedJsonValue;
      try { value = recovering ? pending.receipt.deliveredResult() : await pending.receipt.result(); }
      catch (error) {
        if (!(error instanceof EmbeddedResultReleaseError)) throw error;
        this.#needsRelease = true;
        // A copied success advances the checkpoint before reporting release failure; never remove the slot twice.
        // 复制成功在报告释放失败前推进检查点；绝不移除同一槽两次。
        try { const copied = pending.receipt.deliveredResult(); this.validateControl(type, copied); accept(copied); pending.consumed = true; }
        catch {
          // Keep the original receipt for explicit recovery of its exact delivery.
          // 保留原回执以显式恢复精确交付。
        }
        throw error;
      }
      this.validateControl(type, value);
      accept(value);
      this.clearPending();
    } catch (error) {
      const capacityRejected = error instanceof EmbeddedTransportError && error.functionName === "luaskills_ffi_embedded_request_v1" && error.status === EmbeddedNativeStatus.CAPACITY_EXCEEDED;
      if (!this.#needsRelease && (error instanceof EmbeddedRuntimeError || capacityRejected)) this.clearPending();
      throw error;
    }
  }

  /** Resume the last proven checkpoint; retry recovers buffers and pump evidence without re-executing host handlers.
   * 从最后已证明检查点继续；retry 恢复缓冲及泵证据，不重新执行宿主处理器。
   * @returns Only after native slot removal and real control-worker exit.
   * 仅在原生槽移除及控制线程实际退出后返回。 */
  private async drain(retry: boolean): Promise<void> {
    await this.#startup;
    if (this.#needsRelease) {
      await this.#executor.releaseResults();
      this.#needsRelease = false;
      if (this.#pending !== null && this.#pending.consumed) this.clearPending();
    }
    if (this.#phase === "open") this.#phase = "closing_runtime";
    if (this.#phase === "closing_runtime") await this.control("runtime_close", () => { this.#phase = "draining_runtime"; });
    if (this.#phase === "draining_runtime") {
      // Keep callback delivery available until automatic finalizers and actual core ownership drain.
      // 自动关闭函数和真实核心所有权排空前，保持回调交付可用。
      if (retry && this.#pump !== null && this.#pump.recoveryRequired) await this.#pump.retryAcknowledgements();
      while (this.#phase === "draining_runtime") {
        if (this.#pump !== null && this.#pump.recoveryRequired) throw new Error("Callback pump requires explicit delivery recovery before runtime release");
        await this.control("runtime_status", (value) => {
          const snapshot = value as OutputRuntimeSnapshot;
          if (snapshot.initialization === "faulted") throw new Error("Faulted initialization prevents proving safe runtime release");
          if (snapshot.closed) this.#phase = "draining_callbacks";
        });
        if (this.#phase === "draining_runtime") await pauseEmbeddedPoll(this.#pollIntervalMs);
      }
    }
    if (this.#phase === "draining_callbacks") {
      if (this.#pump !== null) {
        if (retry && !this.#pump.status.closed && this.#pump.recoveryRequired) await this.#pump.retryAcknowledgements();
        let settled = false;
        let failure: unknown = null;
        const closing = this.#pump.close().then(() => { settled = true; }, (error) => { failure = error; settled = true; });
        while (!settled) {
          if (this.#pump.recoveryRequired) throw new Error("Callback pump requires explicit delivery recovery before runtime release");
          await pauseEmbeddedPoll(this.#pollIntervalMs);
        }
        await closing;
        if (failure !== null) throw failure;
      }
      this.#phase = "releasing_runtime";
    }
    if (this.#phase === "releasing_runtime") {
      while (this.#phase === "releasing_runtime") {
        try { await this.control("runtime_free", () => { this.#phase = "released"; }); }
        catch (error) {
          // Core busy is rejected before mutation while leases remain; no other mutation failure is replayed.
          // 核心 busy 在租约仍存活时于变更前拒绝；不重放其他变更失败。
          if (!(error instanceof EmbeddedRuntimeError) || error.code !== "busy") throw error;
          await pauseEmbeddedPoll(this.#pollIntervalMs);
        }
      }
    }
    if (this.#phase === "released") {
      await this.#executor.close();
      this.#executor.releaseOwnership();
      LIVE_SCOPES.delete(this);
      this.#phase = "closed";
    }
  }
}
