import type * as wire from "./embedded-contract.js";
import { EmbeddedCommand, EmbeddedCommandDriver, type EmbeddedCommandLane } from "./embedded-driver.js";
import { checkEmbeddedCallbackWait, EMBEDDED_POLL_INTERVAL_MS, pauseEmbeddedPoll, validateEmbeddedPollInterval } from "./embedded-observation.js";

/** Exact generated root commands; runtime operations have their own response namespace.
 * 精确生成的根命令；运行时操作使用独立响应命名空间。 */
type RootCommand = Exclude<wire.InputCommand, { type: "runtime" }>;
/** Compiler-checked terminal phases; cancellation intent and cleanup are not completion proof.
 * 编译器校验的终态集合；取消意图及清理阶段不代表完成证明。 */
const TERMINAL_PHASES: Readonly<Record<wire.OutputOperationPhase, boolean>> = Object.freeze({ queued: false, initializing: false, running: false, waiting_for_host: false, cleaning: false, succeeded: true, failed: true, cancelled: true });

/**
 * Require one exact nonempty identity without probing its existence or inferring a generation.
 * 要求一个精确非空身份，不探测存在性，也不推断代次。
 * @param value Native identity or exact host-assigned plugin identity.
 * 原生身份或精确宿主分配的插件身份。
 * @returns The same identity, or an explicit local argument error.
 * 相同身份，或显式本地参数错误。
 */
function identity(value: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError("Embedded handle requires an exact nonempty identity");
  return value;
}

/** A typed projection of one retained native command receipt; observing never resubmits the command.
 * 一个保留原生命令回执的类型投影；观察绝不重新提交命令。 */
export class EmbeddedPending<T> {
  // Receipt evidence and its local projection remain independent from observer lifetime.
  // 回执证据及本地投影独立于观察者生命周期。
  readonly #receipt: EmbeddedCommand;
  readonly #project: (value: wire.EmbeddedJsonValue) => T;

  /**
   * Bind an existing receipt and projection without issuing or waiting for native work.
   * 绑定现有回执及投影，不发起或等待原生工作。
   * @param receipt Exact retained driver receipt.
   * 精确保留的驱动器回执。
   * @param project Local projection applied only to successfully decoded evidence.
   * 仅应用于成功解码证据的本地投影。
   */
  constructor(receipt: EmbeddedCommand, project: (value: wire.EmbeddedJsonValue) => T) { this.#receipt = receipt; this.#project = project; Object.freeze(this); }
  /** Return exact recovery evidence, including after cancelled observation or projection failure.
   * 返回精确恢复证据，包括观察取消或投影失败之后。 */
  get receipt(): EmbeddedCommand { return this.#receipt; }
  /**
   * Observe the original native response and return its typed projection.
   * 观察原始原生响应并返回其类型投影。
   * @param options Optional observer signal; abort does not cancel native execution.
   * 可选观察信号；中止不取消原生执行。
   * @returns Typed delivery, preserving the receipt on every failure.
   * 类型化交付；每种失败均保留回执。
   */
  async result(options: { signal?: AbortSignal } = {}): Promise<T> { return this.#project(await this.#receipt.result(options)); }
  /** Recover the original copied response without replay or release, returning its typed projection.
   * 不重放或释放地恢复原始复制响应，返回其类型投影。 */
  deliveredResult(): T { return this.#project(this.#receipt.deliveredResult()); }
  /** Forget only a completed SDK receipt; this does not remove a native operation or resource.
   * 仅遗忘已完成 SDK 回执；不移除原生操作或资源。 */
  forget(): void { this.#receipt.forget(); }
  /**
   * Derive another local view of the same retained receipt without creating a second native command.
   * 派生相同保留回执的另一本地视图，不创建第二个原生命令。
   * @param project Projection of the original typed value; errors retain the original receipt.
   * 原类型值的投影；错误保留原回执。
   * @returns A new view sharing exact underlying delivery ownership.
   * 共享精确底层交付所有权的新视图。
   */
  map<U>(project: (value: T) => U): EmbeddedPending<U> { return new EmbeddedPending(this.#receipt, (value) => project(this.#project(value))); }
}

/** Typed facade borrowing a driver; constructing it does not create or close any native resources.
 * 借用驱动器的类型入口；构造不创建或关闭任何原生资源。 */
export class EmbeddedClient {
  // The driver owns command evidence and the unique borrowed transport.
  // 驱动器拥有命令证据及唯一借用传输。
  readonly #driver: EmbeddedCommandDriver;
  /**
   * Bind a caller-owned driver without waiting for startup.
   * 绑定调用方拥有的驱动器，不等待启动。
   * @param driver Exact driver retained for all submitted receipts.
   * 为全部提交回执保留的精确驱动器。
   */
  constructor(driver: EmbeddedCommandDriver) { this.#driver = driver; Object.freeze(this); }
  /** Return the borrowed driver for explicit receipt recovery and lifecycle coordination.
   * 返回借用驱动器，用于显式回执恢复及生命周期协调。 */
  get driver(): EmbeddedCommandDriver { return this.#driver; }
  /**
   * Submit an exact root command and project its generated response type.
   * 提交精确根命令并投影其生成响应类型。
   * @param command Generated command with no legacy aliases.
   * 不含旧别名的生成命令。
   * @param lane Explicit work or reserved control lane selected by the typed method.
   * 类型方法选择的显式业务或预留控制通道。
   * @returns Retained receipt with the exact generated response result.
   * 带精确生成响应结果的保留回执。
   * @internal
   */
  root<C extends RootCommand>(command: C, lane: EmbeddedCommandLane): EmbeddedPending<wire.EmbeddedRootResponseMap[C["type"]]["result"]> {
    return new EmbeddedPending(this.#driver.submit(command, lane), (value) => value as wire.EmbeddedRootResponseMap[C["type"]]["result"]);
  }
  /** Return a retained receipt describing the actual loaded core protocol and budgets.
   * 返回描述实际已加载核心协议及预算的保留回执。 */
  describe(): EmbeddedPending<wire.OutputTransportDescription> { return this.root({ type: "describe" }, "control"); }
  /** Reserve a native slot and return its original identity receipt, without initializing it.
   * 预留原生槽并返回其原始身份回执，不执行初始化。 */
  reserve(): EmbeddedPending<EmbeddedRuntime> { return this.root({ type: "runtime_reserve" }, "work").map((value) => this.runtime(value.runtime_id)); }
  /** Bind known runtimeId without probing existence; return an immutable local handle.
   * 绑定已知 runtimeId，不探测存在性；返回不可变本地句柄。 */
  runtime(runtimeId: string): EmbeddedRuntime { return new EmbeddedRuntime(this, runtimeId); }
}

/** One exact native runtime namespace; no constructor or successful admission implies readiness.
 * 一个精确原生运行时命名空间；构造或成功入场不代表已就绪。 */
export class EmbeddedRuntime {
  // This pair is the sole routing authority for every child handle.
  // 此组合是每个子句柄的唯一路由权威。
  readonly #client: EmbeddedClient;
  readonly #runtimeId: string;
  /**
   * Bind a client and exact runtime identity without native work.
   * 绑定客户端及精确运行时身份，不执行原生工作。
   * @param client Borrowed command facade.
   * 借用命令入口。
   * @param runtimeId Original transport-local identity.
   * 原始传输局部身份。
   */
  constructor(client: EmbeddedClient, runtimeId: string) { this.#client = client; this.#runtimeId = identity(runtimeId); Object.freeze(this); }
  /** Return the exact borrowed client for lifecycle ownership coordination.
   * 返回精确借用客户端，用于生命周期所有权协调。 */
  get client(): EmbeddedClient { return this.#client; }
  /** Return the original runtime identity, never a name-based replacement.
   * 返回原始运行时身份，绝不按名称替换。 */
  get runtimeId(): string { return this.#runtimeId; }
  /**
   * Bind an exact generated operation to this immutable runtime namespace.
   * 将精确生成操作绑定到此不可变运行时命名空间。
   * @param operation Generated runtime command; blocking waits remain unsupported by the driver.
   * 生成运行时命令；驱动器仍不支持阻塞等待。
   * @param lane Explicit work or control lane.
   * 显式业务或控制通道。
   * @returns Retained generated result, with no implicit receipt forgetting.
   * 保留的生成结果，不隐式遗忘回执。
   * @internal
   */
  request<C extends wire.InputRuntimeCommand>(operation: C, lane: EmbeddedCommandLane): EmbeddedPending<wire.EmbeddedRuntimeResponseMap[C["type"]]["result"]> {
    return new EmbeddedPending(this.#client.driver.submit({ type: "runtime", runtime_id: this.#runtimeId, operation }, lane), (value) => value as wire.EmbeddedRuntimeResponseMap[C["type"]]["result"]);
  }
  /**
   * Start one-shot initialization; its acknowledgement records an attempt, not successful construction.
   * 启动单次初始化；其确认记录尝试，不代表成功构造。
   * @param engineOptions Explicit generated engine options.
   * 显式生成引擎选项。
   * @param runtimeConfig Explicit aggregate runtime budgets.
   * 显式聚合运行时预算。
   * @param persistence Explicit host database and storage budgets; null selects memory-only execution.
   * 显式宿主数据库与存储预算；空值选择纯内存执行。
   * @returns Attempt receipt; query status for ready, failed or faulted and never replay initialization.
   * 尝试回执；查询状态区分就绪、失败或故障，不重放初始化。
   */
  initialize(engineOptions: wire.InputLuaEngineOptions, runtimeConfig: wire.InputEmbeddedRuntimeConfig, persistence: wire.InputRuntimePersistenceConfig | null = null): EmbeddedPending<wire.OutputRuntimeReceipt> {
      return this.#client.root({ type: "runtime_initialize", runtime_id: this.#runtimeId, engine_options: engineOptions, runtime_config: runtimeConfig, persistence }, "work");
    }
  /** Query actual initialization and closure state; return a retained native snapshot receipt.
   * 查询实际初始化及关闭状态；返回保留原生快照回执。 */
  status(): EmbeddedPending<wire.OutputRuntimeSnapshot> { return this.#client.root({ type: "runtime_status", runtime_id: this.#runtimeId }, "control"); }
  /** Return actual storage worker ownership on the control lane; memory-only runtimes reject the request.
   * 在控制通道返回实际存储工作线程所有权；纯内存运行时拒绝请求。 */
  storageStatus(): EmbeddedPending<wire.OutputOperationJournalWorkerStatus> { return this.request({ type: "storage_status" }, "control"); }
  /** Reopen and validate the original failed database on the work lane; return whether recovery was needed.
   * 在工作通道重新打开并校验原故障数据库；返回是否需要恢复。
   * This does not retry a checkpoint or execute business work; request the original checkpoint retry separately.
   * 此操作不重试检查点或执行业务工作；需独立请求原检查点重试。 */
  recoverStorage(): EmbeddedPending<boolean> { return this.request({ type: "storage_recover" }, "work"); }
  /** Rebuild one failed, actually exited writer on the work lane; false means a healthy running writer.
   * 在工作通道重建一个已失败且实际退出的写入者；假表示健康运行写入者。
   * Preserve old receipts and budgets; storage recovery and checkpoint retries remain separate actions.
   * 保留旧回执及预算；存储恢复与检查点重试仍为独立操作。
   * Explicit writer closure and unproven or poisoned ownership remain errors, never implicit reopening.
   * 显式写入者关闭及未证实或中毒所有权保持错误，绝不隐式重新打开。 */
  recoverStorageWorker(): EmbeddedPending<boolean> { return this.request({ type: "storage_worker_recover" }, "work"); }
  /** Read exact original historyRuntimeId/operationId on the work lane; null does not prove no execution occurred.
   * 在工作通道读取精确原始 historyRuntimeId/operationId；空值不证明从未执行。 */
  historyGet(historyRuntimeId: string, operationId: string): EmbeddedPending<wire.OutputJournalOperation | null> {
    return this.request({ type: "history_get", history_runtime_id: historyRuntimeId, operation_id: operationId }, "work");
  }
  /** Read one row after the original cursor, or the first row for null; return null at enumeration end.
   * 读取原始游标之后的一条记录，空值表示首条；枚举结束返回空值。
   * Concurrent changes are not a multi-call snapshot; historical identities do not become active handles.
   * 并发变更不构成跨调用快照；历史身份不会成为活动句柄。 */
  historyNext(after: wire.InputHistoryCursor | null = null): EmbeddedPending<wire.OutputJournalOperation | null> {
    return this.request({ type: "history_next", after }, "work");
  }
  /** Attach final trusted-host resolution to exact original history and return its durable successor revision.
   * 为精确原历史附加最终可信宿主 resolution，并返回其持久后继修订。
   * The host must authorize the resolver, verify every effect and prove all original owners stopped.
   * 宿主必须授权对账者、核验全部副作用并证明所有原所有者已停止。
   * Exact retries retain expectedRevision and every resolution field; retained live operations are rejected.
   * 精确重试保留 expectedRevision 及全部 resolution 字段；仍保留的活动操作被拒绝。 */
  historyReconcile(historyRuntimeId: string, operationId: string, expectedRevision: wire.EmbeddedInteger, resolution: wire.InputOperationReconciliation): EmbeddedPending<wire.EmbeddedInteger> {
    return this.request({ type: "history_reconcile", history_runtime_id: historyRuntimeId, operation_id: operationId, expected_revision: expectedRevision, resolution }, "work");
  }
  /** Delete fully resolved history at expectedRevision; forget any retained live operation first.
   * 按 expectedRevision 删除已完全解决的历史；需先遗忘仍保留的活动操作。
   * Return the deletion receipt; stale revisions and unresolved effects preserve the record.
   * 返回删除回执；过期修订和未决副作用保留记录。 */
  historyForget(historyRuntimeId: string, operationId: string, expectedRevision: wire.EmbeddedInteger): EmbeddedPending<null> {
    return this.request({ type: "history_forget", history_runtime_id: historyRuntimeId, operation_id: operationId, expected_revision: expectedRevision }, "work");
  }
  /** Request native closure; return acknowledgement without claiming actual drainage.
   * 请求原生关闭；返回确认，不宣称实际排空。 */
  requestClose(): EmbeddedPending<wire.OutputRuntimeReceipt> { return this.#client.root({ type: "runtime_close", runtime_id: this.#runtimeId }, "control"); }
  /** Request exact slot removal; return its receipt and preserve native premature-release rejection.
   * 请求精确槽移除；返回其回执，并保留原生过早释放拒绝。
   */
  free(): EmbeddedPending<wire.OutputRuntimeReceipt> {
    this.#client.driver.borrowedTransport.checkUnmanagedRuntime(this.#runtimeId);
    return this.#client.root({ type: "runtime_free", runtime_id: this.#runtimeId }, "control");
  }
  /**
   * Register a plugin's aggregate budgets across all its pool generations.
   * 注册插件跨全部池代次的聚合预算。
   * @param pluginId Exact host-assigned identity.
   * 精确宿主分配身份。
   * @param config Generated aggregate plugin limits.
   * 生成的聚合插件限制。
   * @returns Handle projected only from successful native acknowledgement.
   * 仅从成功原生确认投影的句柄。
   */
  registerPlugin(pluginId: string, config: wire.InputEmbeddedPluginConfig): EmbeddedPending<EmbeddedPlugin> {
    const exactId = identity(pluginId);
    return this.request({ type: "plugin_register", plugin_id: exactId, config }, "work").map(() => this.plugin(exactId));
  }
  /**
   * Register one immutable execution domain with explicit host grants and revision.
   * 使用显式宿主授权及修订注册一个不可变执行域。
   * @param definition Exact package, generation, source and exports.
   * 精确包、代次、源码及导出。
   * @param policy Shared or dedicated pool policy, including reuse and limits.
   * 公共或专用池策略，包含复用及限制。
   * @param permissions Explicit host-granted permission set.
   * 显式宿主授权权限集合。
   * @param executionRevision Immutable host configuration revision.
   * 不可变宿主配置修订。
   * @returns Actual registered pool handle receipt.
   * 实际已注册池的句柄回执。
   */
  registerPool(definition: wire.InputModuleDefinition, policy: wire.InputPluginPoolConfig, permissions: string[], executionRevision: string): EmbeddedPending<EmbeddedPool> {
    return this.request({ type: "pool_register", definition, policy, permissions, execution_revision: executionRevision }, "work").map((value) => this.pool(value.pool_id));
  }
  /** Bind known pluginId and return a handle without probing its native existence.
   * 绑定已知 pluginId 并返回句柄，不探测其原生存在性。 */
  plugin(pluginId: string): EmbeddedPlugin { return new EmbeddedPlugin(this, pluginId); }
  /** Register complete config for exact pluginId; return the acknowledged capacity without replay.
   * 为精确 pluginId 注册完整 config；返回已确认容量，不重放。 */
  registerCapacity(pluginId: string, config: wire.InputEmbeddedCapacityConfig): EmbeddedPending<EmbeddedCapacity> {
    return this.request({ type: "capacity_register", plugin_id: pluginId, config }, "work")
      .map((value) => this.capacity(value.capacity_id));
  }
  /** Bind exact capacityId to this runtime without probing; return an immutable local handle.
   * 将精确 capacityId 绑定到此运行时，不探测；返回不可变本地句柄。 */
  capacity(capacityId: string): EmbeddedCapacity { return new EmbeddedCapacity(this, capacityId); }
  /** Bind known poolId and return a handle without inferring its generation or policy.
   * 绑定已知 poolId 并返回句柄，不推断其代次或策略。 */
  pool(poolId: string): EmbeddedPool { return new EmbeddedPool(this, poolId); }
  /** Bind known sessionId and return a handle without assuming initialization succeeded.
   * 绑定已知 sessionId 并返回句柄，不假设初始化成功。 */
  session(sessionId: string): EmbeddedSession { return new EmbeddedSession(this, sessionId); }
  /** Bind known operationId and return its queryable original execution handle.
   * 绑定已知 operationId 并返回其可查询原始执行句柄。 */
  operation(operationId: string): EmbeddedOperation { return new EmbeddedOperation(this, operationId); }
  /** Discover at most limit retained identities for optional poolId after retained afterOperationId; return publication order.
   * 为可选 poolId 发现保留的 afterOperationId 之后至多 limit 个保留身份；返回发布顺序。
   * Restart after forgetting a cursor; each returned identity retains independently queryable native outcomes.
   * 遗忘游标后重新开始；每个返回身份保留可独立查询的原生结果。 */
  listOperations(poolId: string | null, afterOperationId: string | null, limit: wire.EmbeddedInteger): EmbeddedPending<wire.OutputOperationPage> {
    return this.request({ type: "operation_list", pool_id: poolId, after_operation_id: afterOperationId, limit }, "control");
  }
}

/** Immutable plugin registration handle with live aggregate native accounting.
 * 包含实时聚合原生计费的不可变插件注册句柄。 */
export class EmbeddedPlugin {
  // Preserve the exact namespace and host-assigned registration identity.
  // 保留精确命名空间及宿主分配注册身份。
  readonly #runtime: EmbeddedRuntime;
  readonly #pluginId: string;
  /** Bind runtime and pluginId without native registration; return a local identity handle.
   * 绑定 runtime 和 pluginId，不进行原生注册；返回本地身份句柄。 */
  constructor(runtime: EmbeddedRuntime, pluginId: string) { this.#runtime = runtime; this.#pluginId = identity(pluginId); Object.freeze(this); }
  /** Return the original plugin identity.
   * 返回原始插件身份。 */
  get pluginId(): string { return this.#pluginId; }
  /** Return a retained live aggregate usage snapshot.
   * 返回保留的实时聚合用量快照。 */
  status(): EmbeddedPending<wire.OutputEmbeddedPluginSnapshot> { return this.#runtime.request({ type: "plugin_status", plugin_id: this.#pluginId }, "control"); }
  /** Close plugin admission; return acknowledgement without equating it with actual drainage.
   * 关闭插件入场；返回确认，不将其等同实际排空。 */
  requestClose(): EmbeddedPending<null> { return this.#runtime.request({ type: "plugin_close", plugin_id: this.#pluginId }, "control"); }
  /** Remove only a drained plugin record; return the retained native acknowledgement.
   * 仅移除已排空插件记录；返回保留原生确认。 */
  forget(): EmbeddedPending<null> { return this.#runtime.request({ type: "plugin_forget", plugin_id: this.#pluginId }, "control"); }
}

/** Immutable plugin-owned capacity shared by isolated modules; native ownership remains authoritative.
 * 隔离模块共享的不可变插件自有容量；原生归属保持权威。 */
export class EmbeddedCapacity {
  // Every member and lifecycle request uses the original runtime namespace.
  // 每个成员及生命周期请求使用原始运行时命名空间。
  readonly #runtime: EmbeddedRuntime;
  // Failure and plugin updates never replace this exact capacity identity.
  // 失败及插件更新绝不替换此精确容量身份。
  readonly #capacityId: string;
  /** Bind runtime and capacityId without registration or probing; return an immutable handle.
   * 绑定 runtime 和 capacityId，不注册或探测；返回不可变句柄。 */
  constructor(runtime: EmbeddedRuntime, capacityId: string) {
    this.#runtime = runtime;
    this.#capacityId = identity(capacityId);
    Object.freeze(this);
  }
  /** Return the exact native capacity identity, distinct from a command receipt.
   * 返回精确原生容量身份，区别于命令回执。 */
  get capacityId(): string { return this.#capacityId; }
  /** Return live physical, queue and cleanup ownership through the reserved control lane.
   * 通过预留控制通道返回实时物理、排队及清理归属。 */
  status(): EmbeddedPending<wire.OutputEmbeddedCapacitySnapshot> {
    return this.#runtime.request({ type: "capacity_status", capacity_id: this.#capacityId }, "control");
  }
  /** Return the atomic native revision, current policy and convergence on the reserved control lane.
   * 在预留控制通道返回原子原生修订、当前策略及收敛状态。 */
  policy(): EmbeddedPending<wire.OutputEmbeddedCapacityPolicySnapshot> {
    return this.#runtime.request({ type: "capacity_policy", capacity_id: this.#capacityId }, "control");
  }
  /** Compare expectedRevision and replace complete config; return the retained committed-token receipt.
   * 比较 expectedRevision 并替换完整 config；返回保留的已提交令牌回执。
   * Preserve native conflicts and closure; never refresh or retry the token automatically.
   * 保留原生冲突及关闭；绝不自动刷新或重试令牌。 */
  revise(expectedRevision: string, config: wire.InputEmbeddedCapacityConfig): EmbeddedPending<string> {
    return this.#runtime.request({ type: "capacity_revise", capacity_id: this.#capacityId,
      expected_revision: expectedRevision, config }, "control");
  }
  /** Stop admission and request member drainage; return acknowledgement without claiming completion.
   * 停止入场并请求成员排空；返回确认，不宣称完成。 */
  requestClose(): EmbeddedPending<null> {
    return this.#runtime.request({ type: "capacity_close", capacity_id: this.#capacityId }, "control");
  }
  /** Forget only an eligible drained capacity; members must be forgotten first.
   * 仅遗忘符合条件的已排空容量；必须先遗忘成员。 */
  forget(): EmbeddedPending<null> {
    return this.#runtime.request({ type: "capacity_forget", capacity_id: this.#capacityId }, "control");
  }
  /** Register definition, policy, permissions and executionRevision in this capacity; return its acknowledged member.
   * 在此容量中注册 definition、policy、permissions 和 executionRevision；返回已确认成员。
   * Native checks reject foreign plugins and conflicting budgets without independent-placement fallback.
   * 原生检查拒绝外来插件及冲突预算，不回退独立归属。 */
  registerPool(definition: wire.InputModuleDefinition, policy: wire.InputPluginPoolConfig, permissions: string[], executionRevision: string): EmbeddedPending<EmbeddedPool> {
    return this.#runtime.request({ type: "pool_register", capacity_id: this.#capacityId, definition, policy, permissions, execution_revision: executionRevision }, "work")
      .map((value) => this.#runtime.pool(value.pool_id));
  }
}

/** Immutable pool identity preserving its original package generation and host initialization revision.
 * 不可变池身份，保留其原始包代次及宿主初始化修订。 */
export class EmbeddedPool {
  // All commands remain bound to one exact runtime/pool pair.
  // 全部命令始终绑定一个精确运行时与池组合。
  readonly #runtime: EmbeddedRuntime;
  readonly #poolId: string;
  /** Bind runtime and poolId without registration; return a local immutable handle.
   * 绑定 runtime 和 poolId，不进行注册；返回本地不可变句柄。 */
  constructor(runtime: EmbeddedRuntime, poolId: string) { this.#runtime = runtime; this.#poolId = identity(poolId); Object.freeze(this); }
  /** Return the exact original pool identity.
   * 返回精确原始池身份。 */
  get poolId(): string { return this.#poolId; }
  /** Return real native VM accounting, including creation and retirement.
   * 返回真实原生 VM 计费，包含创建及退役。 */
  status(): EmbeddedPending<wire.OutputPoolUsage> { return this.#runtime.request({ type: "pool_status", pool_id: this.#poolId }, "control"); }
  /** Request permanent pool closure; return acknowledgement without inferring actual VM destruction.
   * 请求永久关闭池；返回确认，不推断实际 VM 销毁。 */
  requestClose(): EmbeddedPending<null> { return this.#runtime.request({ type: "pool_close", pool_id: this.#poolId }, "control"); }
  /** Remove the pool record only when native release conditions permit; return its receipt.
   * 仅在原生释放条件允许时移除池记录；返回其回执。 */
  forget(): EmbeddedPending<null> { return this.#runtime.request({ type: "pool_forget", pool_id: this.#poolId }, "control"); }
  /** Revoke exact permission and return whether the live native grant changed.
   * 撤销精确 permission，并返回实时原生授权是否变化。 */
  revokePermission(permission: string): EmbeddedPending<boolean> { return this.#runtime.request({ type: "pool_revoke_permission", pool_id: this.#poolId, permission }, "control"); }
  /**
   * Admit an ordinary call without waiting for Lua completion.
   * 接纳普通调用，不等待 Lua 完成。
   * @param exportName Declared export name.
   * 声明的导出名称。
   * @param argumentsValue Structured application arguments.
   * 结构化应用参数。
   * @param context Explicit trusted host invocation context.
   * 显式可信宿主调用上下文。
   * @param timeoutMs Original native end-to-end execution budget, distinct from observer cancellation.
   * 原始原生端到端执行预算，独立于观察取消。
   * @returns Original queryable operation identity receipt.
   * 原始可查询操作身份回执。
   */
  submit(exportName: string, argumentsValue: wire.EmbeddedJsonValue, context: wire.InputLuaInvocationContext, timeoutMs: wire.EmbeddedInteger): EmbeddedPending<EmbeddedOperation> {
    return this.#runtime.request({ type: "call_submit", call: { pool_id: this.#poolId, export: exportName, arguments: argumentsValue, context }, timeout_ms: timeoutMs }, "work").map((value) => this.#runtime.operation(value.operation_id));
  }
  /** Reserve a fixed session with timeoutMs initialization budget; return session and initialization handles.
   * 使用 timeoutMs 初始化预算预留固定会话；返回会话及初始化句柄。 */
  openSession(timeoutMs: wire.EmbeddedInteger): EmbeddedPending<EmbeddedSessionOpen> {
    return this.#runtime.request({ type: "session_open", pool_id: this.#poolId, timeout_ms: timeoutMs }, "work").map((value) => new EmbeddedSessionOpen(this.#runtime.session(value.session_id), this.#runtime.operation(value.operation_id)));
  }
}

/** Exact paired native identities; session admission alone is not successful initialization.
 * 精确配对原生身份；会话入场本身不代表成功初始化。 */
export class EmbeddedSessionOpen {
  /** Queryable session identity, including after failed initialization.
   * 可查询会话身份，包括初始化失败之后。 */
  readonly session: EmbeddedSession;
  /** Original initialization operation retaining terminal and effect evidence.
   * 保留终态及副作用证据的原始初始化操作。 */
  readonly initialization: EmbeddedOperation;
  /** Bind session and initialization handles from one receipt; return an immutable identity pair.
   * 绑定同一回执的 session 和 initialization 句柄；返回不可变身份组合。 */
  constructor(session: EmbeddedSession, initialization: EmbeddedOperation) { this.session = session; this.initialization = initialization; Object.freeze(this); }
}

/** Fixed session handle; calls preserve the original VM rather than switching to a shared-pool invocation.
 * 固定会话句柄；调用保留原始 VM，不切换为公共池调用。 */
export class EmbeddedSession {
  // Stable identity remains available for status and closure after execution failure.
  // 稳定身份在执行失败后仍可用于状态及关闭。
  readonly #runtime: EmbeddedRuntime;
  readonly #sessionId: string;
  /** Bind exact runtime and sessionId without initialization; return a local immutable handle.
   * 绑定精确 runtime 和 sessionId，不执行初始化；返回本地不可变句柄。 */
  constructor(runtime: EmbeddedRuntime, sessionId: string) { this.#runtime = runtime; this.#sessionId = identity(sessionId); Object.freeze(this); }
  /** Return the original native session identity.
   * 返回原始原生会话身份。 */
  get sessionId(): string { return this.#sessionId; }
  /** Return actual initialization, active-operation and closure evidence.
   * 返回实际初始化、活动操作及关闭证据。 */
  status(): EmbeddedPending<wire.OutputEmbeddedSessionSnapshot> { return this.#runtime.request({ type: "session_status", session_id: this.#sessionId }, "control"); }
  /** Request closure and return its acknowledgement; outstanding work remains independently queryable.
   * 请求关闭并返回其确认；未完成工作继续保持独立可查询。 */
  requestClose(): EmbeddedPending<null> { return this.#runtime.request({ type: "session_close", session_id: this.#sessionId }, "control"); }
  /** Remove only a drained session record and return its retained receipt.
   * 仅移除已排空会话记录，并返回其保留回执。 */
  forget(): EmbeddedPending<null> { return this.#runtime.request({ type: "session_forget", session_id: this.#sessionId }, "control"); }
  /**
   * Admit one call on this exact fixed session.
   * 在此精确固定会话上接纳一个调用。
   * @param exportName Declared export name.
   * 声明的导出名称。
   * @param argumentsValue Structured application arguments.
   * 结构化应用参数。
   * @param context Explicit trusted host invocation context.
   * 显式可信宿主调用上下文。
   * @param timeoutMs Native execution budget independent from observation lifetime.
   * 原生执行预算，独立于观察生命周期。
   * @returns Original admitted operation identity receipt.
   * 原始已入场操作身份回执。
   */
  submit(exportName: string, argumentsValue: wire.EmbeddedJsonValue, context: wire.InputLuaInvocationContext, timeoutMs: wire.EmbeddedInteger): EmbeddedPending<EmbeddedOperation> {
    return this.#runtime.request({ type: "session_submit", session_id: this.#sessionId, export: exportName, arguments: argumentsValue, context, timeout_ms: timeoutMs }, "work").map((value) => this.#runtime.operation(value.operation_id));
  }
}

/** Queryable admitted operation; cancellation intent never substitutes for native terminal evidence.
 * 可查询已入场操作；取消意图绝不替代原生终态证据。 */
export class EmbeddedOperation {
  // Preserve the exact identity through every observer, cancel request and receipt recovery.
  // 跨每个观察者、取消请求和回执恢复保留精确身份。
  readonly #runtime: EmbeddedRuntime;
  readonly #operationId: string;
  /** Bind runtime and operationId without waiting or cancellation; return an immutable local handle.
   * 绑定 runtime 和 operationId，不等待或取消；返回不可变本地句柄。 */
  constructor(runtime: EmbeddedRuntime, operationId: string) { this.#runtime = runtime; this.#operationId = identity(operationId); Object.freeze(this); }
  /** Return the original operation identity used for status, cancellation and explicit forgetting.
   * 返回用于状态、取消及显式遗忘的原始操作身份。 */
  get operationId(): string { return this.#operationId; }
  /** Return a retained native snapshot with complete available effect evidence, including after failure.
   * 返回保留原生快照及完整可用副作用证据，包括失败之后。 */
  status(): EmbeddedPending<wire.OutputOperationSnapshot> { return this.#runtime.request({ type: "operation_status", operation_id: this.#operationId }, "control"); }
  /** Return the retained original checkpoint failure without disk waits or implicit retries.
   * 返回保留的原始检查点故障，不等待磁盘或隐式重试。 */
  persistenceFailure(): EmbeddedPending<wire.OutputOperationPersistenceFailure | null> { return this.#runtime.request({ type: "operation_persistence_failure", operation_id: this.#operationId }, "control"); }
  /** Request one checkpoint retry; false means already pending and no failure reports busy.
   * 请求一次检查点重试；假表示已在等待，不存在故障则报告忙碌。
   * Return the receipt without replaying Lua or host callbacks or replacing the original result.
   * 返回回执，不重放 Lua 或宿主回调，也不替换原结果。 */
  retryCheckpoint(): EmbeddedPending<boolean> { return this.#runtime.request({ type: "operation_retry_checkpoint", operation_id: this.#operationId }, "control"); }
  /** Request cooperative cancellation; return whether intent changed, without implying actual completion.
   * 请求协作取消；返回意图是否变化，不代表实际完成。 */
  cancel(): EmbeddedPending<boolean> { return this.#runtime.request({ type: "operation_cancel", operation_id: this.#operationId }, "control"); }
  /** Remove a native terminal operation record; return acknowledgement separately from SDK receipt quota.
   * 移除原生终态操作记录；返回确认，独立于 SDK 回执配额。 */
  forget(): EmbeddedPending<null> { return this.#runtime.request({ type: "operation_forget", operation_id: this.#operationId }, "control"); }
  /**
   * Poll actual status without holding a native worker or treating observer abort as operation cancellation.
   * 轮询实际状态，不占住原生工作线程，也不将观察中止视为操作取消。
   * @param options Optional observer signal and validated integer polling interval in milliseconds.
   * 可选观察信号及经过校验的整数毫秒轮询间隔。
   * @returns Any terminal snapshot with effects; interrupted or failed query receipts remain on the driver.
   * 任意终态快照及副作用；中断或失败的查询回执继续保留在驱动器中。
   */
  async wait(options: { signal?: AbortSignal; pollIntervalMs?: number } = {}): Promise<wire.OutputOperationSnapshot> {
    checkEmbeddedCallbackWait();
    const interval = options.pollIntervalMs === undefined ? EMBEDDED_POLL_INTERVAL_MS : options.pollIntervalMs;
    validateEmbeddedPollInterval(interval);
    const signal = options.signal;
    while (true) {
      signal?.throwIfAborted();
      const pending = this.status();
      const snapshot = await pending.result(signal === undefined ? {} : { signal });
      pending.forget();
      if (TERMINAL_PHASES[snapshot.phase]) return snapshot;
      await pauseEmbeddedPoll(interval, signal);
    }
  }
}
