import { EmbeddedClient, EmbeddedCommandDriver, EmbeddedRuntime, EmbeddedRuntimeScope, EmbeddedPending, EmbeddedOperation, createEngineOptions, type embeddedContract } from "../../dist/index.js";

/**
 * Compile a public consumer against distributed declarations; this fixture is never executed.
 * 对分发声明编译公开消费者；此夹具不会被执行。
 * @param driver Borrowed command driver with retained native receipts.
 * 包含保留原生回执的借用命令驱动器。
 * @param config Exact generated runtime configuration.
 * 精确生成运行时配置。
 * @param definition Exact immutable module definition.
 * 精确不可变模块定义。
 * @param policy Generated shared or dedicated pool policy.
 * 生成的公共或专用池策略。
 * @returns Type-checked observation chain if manually invoked.
 * 若手工调用，返回经过类型校验的观察链。
 */
export async function typedConsumer(driver: EmbeddedCommandDriver, config: embeddedContract.InputEmbeddedRuntimeConfig, definition: embeddedContract.InputModuleDefinition, policy: embeddedContract.InputPluginPoolConfig): Promise<void> {
  // Reserve and generated initialization options must compose through the public package facade.
  // 预留与生成初始化选项必须通过公开包入口组合。
  const client = new EmbeddedClient(driver);
  const reservation: EmbeddedPending<EmbeddedRuntime> = client.reserve();
  const runtime = await reservation.result();
  reservation.forget();
  // Async disposal must be available from the distributed public declarations on the minimum supported Node version.
  // 最低支持 Node 版本必须能从分发公开声明使用异步释放。
  await using scope: EmbeddedRuntimeScope = new EmbeddedRuntimeScope(runtime, { pollIntervalMs: 2 });
  await scope.ready({ signal: AbortSignal.timeout(100) });
  await runtime.initialize(createEngineOptions({ runtimeRoot: ".", hostOptions: { capabilities: { enable_skill_management_bridge: false } } }), config).result();
  // @ts-expect-error Legacy JSON engine options must not accept arbitrary cache values.
  // 旧 JSON 引擎选项不能接受任意缓存值。
  createEngineOptions({ hostOptions: { cache_config: "invalid-cache-policy" } });
  // @ts-expect-error Legacy JSON numeric options must not silently accept bigint serialization.
  // 旧 JSON 数字选项不能静默接受 bigint 序列化。
  createEngineOptions({ hostOptions: { cache_config: { max_entries: 1n, default_ttl_secs: 1, max_ttl_secs: 2 } } });
  // @ts-expect-error Runtime identity cannot be redirected after constructing its handle.
  // 运行时身份不能在构造句柄后重定向。
  runtime.runtimeId = "replacement";
  // Pool calls and fixed-session calls must return operation handles, never pretend to return execution values.
  // 池调用及固定会话调用必须返回操作句柄，不假装返回执行结果。
  const pool = await runtime.registerPool(definition, policy, [], "consumer-v1").result();
  // Revision tokens stay strings throughout the public consumer chain.
  // 修订令牌在公开消费链全过程保持字符串。
  const capacity = runtime.capacity("known-capacity");
  const capacityPolicy: embeddedContract.OutputEmbeddedCapacityPolicySnapshot = await capacity.policy().result();
  const revision: EmbeddedPending<string> = capacity.revise(capacityPolicy.revision, capacityPolicy.capacity.config);
  void revision;
  // @ts-expect-error An opaque native predecessor must not accept an imprecise numeric conversion.
  // 不透明原生前驱不得接受不精确数值转换。
  capacity.revise(1, capacityPolicy.capacity.config);
  const context: embeddedContract.InputLuaInvocationContext = { request_context: null, client_budget: null, tool_config: null };
  const submission: EmbeddedPending<EmbeddedOperation> = pool.submit("call", { integer: 18446744073709551615n }, context, 1000n);
  const operation = await submission.result();
  const snapshot: embeddedContract.OutputOperationSnapshot = await operation.wait({ signal: AbortSignal.timeout(100), pollIntervalMs: 1 });
  const initialized = await pool.openSession(1000n).result();
  const sessionCall: EmbeddedPending<EmbeddedOperation> = initialized.session.submit("call", snapshot.value ?? null, context, 1000n);
  await sessionCall.result();
  // @ts-expect-error Command result maps must not allow a transport description to masquerade as runtime status.
  // 命令结果映射不能允许传输描述冒充运行时状态。
  const invalid: EmbeddedPending<embeddedContract.OutputRuntimeSnapshot> = client.describe();
  void invalid;
}
