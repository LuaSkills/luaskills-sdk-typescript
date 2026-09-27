import { AsyncLocalStorage } from "node:async_hooks";
import { EmbeddedRuntimeError } from "./embedded-transport.js";

/** Exact callback owner inherited by asynchronous continuations, including detached host work.
 * 异步继续执行继承的精确回调所有者，包括脱离处理器的宿主工作。 */
export const HOST_CALLBACK_OWNER = new AsyncLocalStorage<object>();
/** One Node timer upper bound shared by callback, operation and lifecycle polling.
 * 回调、操作和生命周期轮询共用的唯一 Node 定时器上限。 */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;
/** One advisory polling default; core execution deadlines remain authoritative.
 * 唯一参考轮询默认间隔；核心执行截止时间保持权威。 */
export const EMBEDDED_POLL_INTERVAL_MS = 10;

/** Internal promise owner; observer cancellation never settles these callbacks.
 * 内部 Promise 所有者；观察者取消绝不完成这些回调。 */
export interface Completion {
  /** Actual owned completion.
   * 实际拥有的完成对象。 */
  readonly promise: Promise<void>;
  /** Publish actual completion.
   * 发布实际完成。 */
  readonly resolve: () => void;
  /** Publish failure while retaining unproven native ownership.
   * 发布失败，同时保留尚未获证明的原生所有权。 */
  readonly reject: (error: unknown) => void;
}

/**
 * Create an owned completion while preserving rejection for later observers.
 * 创建拥有型完成对象，同时为后续观察者保留拒绝结果。
 * @returns Strongly retained promise and private settlement callbacks.
 * 强保留 Promise 及私有完成回调。
 */
export function completion(): Completion {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((accept, fail) => { resolve = accept; reject = fail; });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

/**
 * Observe owned work without cancelling it when the supplied signal aborts.
 * 观察拥有的工作，提供的信号中止时不取消实际工作。
 * @param pending Actual completion retained independently of this observer.
 * 独立于此观察者保留的实际完成对象。
 * @param signal Optional observer-only cancellation.
 * 可选且仅作用于观察者的取消。
 * @returns Completion or the signal's exact rejection reason.
 * 完成或信号的精确拒绝原因。
 */
export async function observe(pending: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return pending;
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    void pending.then(() => { signal.removeEventListener("abort", abort); resolve(); }, (error) => { signal.removeEventListener("abort", abort); reject(error); });
    if (signal.aborted) abort();
  });
}

/** Reject callback wait cycles until dependency tracking is implemented; return before native admission.
 * 在实现依赖跟踪前拒绝回调等待环；于原生入场之前返回。 */
export function checkEmbeddedCallbackWait(): void {
  if (HOST_CALLBACK_OWNER.getStore() !== undefined) throw new EmbeddedRuntimeError("unsupported", "Nested embedded driver or lifecycle waits from host callbacks are not supported");
}

/**
 * Validate a polling delay before starting any command or allocating native ownership.
 * 在启动命令或分配原生所有权之前校验轮询间隔。
 * @param milliseconds Explicit positive safe integer accepted by Node timers.
 * Node 定时器接受的显式正安全整数。
 * @returns Normally only for a delay that Node will not coerce to an overflow fallback.
 * 仅对不会被 Node 转换为溢出回退值的间隔正常返回。
 */
export function validateEmbeddedPollInterval(milliseconds: number): void {
  if (typeof milliseconds !== "number" || !Number.isSafeInteger(milliseconds) || milliseconds <= 0 || milliseconds > MAX_TIMER_DELAY_MS) throw new RangeError("Embedded polling requires positive integer milliseconds within the Node timer range");
}

/**
 * Wait between successful native queries while preserving the observer's original abort reason.
 * 在成功原生查询之间等待，同时保留观察者的原始中止原因。
 * @param milliseconds Previously validated polling delay.
 * 已校验的轮询间隔。
 * @param signal Optional observer cancellation independent of actual native execution.
 * 可选观察取消，独立于实际原生执行。
 * @returns Completion after the delay or rejection on cancellation, with the timer cleared.
 * 间隔结束后完成或取消时拒绝，并清除定时器。
 */
export async function pauseEmbeddedPoll(milliseconds: number, signal?: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const elapsed = new Promise<void>((resolve) => { timer = setTimeout(resolve, milliseconds); });
  try { await observe(elapsed, signal); }
  finally { clearTimeout(timer); }
}
