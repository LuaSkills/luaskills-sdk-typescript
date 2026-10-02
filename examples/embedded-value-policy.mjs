import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import koffi from "koffi";
import { EmbeddedTransport, EmbeddedCommandDriver, EmbeddedClient, EmbeddedCallbackPump, EmbeddedRuntimeScope, HostCapability, EmbeddedRuntimeError, EmbeddedResultReleaseError, EmbeddedFloat, createEngineOptions } from "../dist/index.js";
import { decodeCoreDescription } from "../dist/embedded-compatibility.js";

// Native admission and callback deadlines use one finite application budget.
// 原生入场及回调截止时间使用唯一有限应用预算。
const nativeTimeoutMs = 5000;
// Observer and successful scope-close checks use one independent wall-clock deadline.
// 观察者及成功作用域关闭检查使用唯一独立墙钟截止时间。
const observerTimeoutMs = 10000;

/**
 * Consume a successful command and release only its SDK receipt quota.
 * 消费成功命令，仅释放其 SDK 回执配额。
 * @template T
 * @param {import('../dist/embedded-client.js').EmbeddedPending<T>} pending Original retained command.
 * 原始保留命令。
 * @returns {Promise<T>} Exact projected native result; failures retain their evidence.
 * 精确投影的原生结果；失败保留证据。
 */
async function consume(pending) {
  // Forget only proven delivery; a failed result must remain available to its owner.
  // 仅遗忘已证明的交付；失败结果必须保持可供所有者读取。
  const result = await pending.result();
  pending.forget();
  return result;
}

/**
 * Verify native Lua integer admission, committed callback failure and owned closure against one selected core.
 * 对一个指定核心验证原生 Lua 整数入场、已提交回调失败及拥有型关闭。
 * @param {string} libraryPath Absolute candidate library file; no asset discovery occurs.
 * 候选库文件的绝对路径；不执行资产发现。
 * @param {Uint8Array} descriptionBytes Frozen OutputCoreDescription JSON supplied by the candidate owner.
 * 候选所有者提供的冻结 OutputCoreDescription JSON。
 * @returns {Promise<object>} Evidence after actual runtime, callback worker, driver and transport release.
 * 实际释放运行时、回调线程、驱动器及传输后的证据。
 */
export async function runEmbeddedValuePolicy(libraryPath, descriptionBytes) {
  assert.ok(isAbsolute(libraryPath), "Candidate library path must be absolute");
  // Reuse the generated compatibility checks, including versions, contract hash and build identity fields.
  // 复用生成的兼容检查，包括版本、契约摘要及构建身份字段。
  const description = decodeCoreDescription(descriptionBytes, koffi.sizeof("void *"));
  assert.deepEqual(description, JSON.parse(Buffer.from(descriptionBytes).toString("utf8")), "Frozen description must have the exact current OutputCoreDescription shape");
  // Four independent response frames cover work, control, callback and scope workers.
  // 四个独立响应帧覆盖业务、控制、回调及作用域线程。
  const transport = new EmbeddedTransport({ max_runtimes: 1, max_result_buffers: 4, max_result_bytes: 131072, max_response_bytes: 32768, max_request_bytes: 65536 }, { libraryPath });
  // Root and all borrowed owners remain local until their proven close checkpoints.
  // 根及全部借用所有者保持本地持有，直到其关闭检查点获证。
  let root = null;
  let driver = null;
  let scope = null;
  let pump = null;
  let runtime = null;
  let callbackCount = 0;
  // Exact request identities retain committed ledger evidence through invalid output projection.
  // 精确请求身份在无效输出投影中保留已提交账本证据。
  const requests = [];
  /** Retain the exact reserve owner before observation can fail after native allocation.
   * 在观察可能于原生分配后失败前，保留精确预留所有者。
   * @type {import('../dist/embedded-client.js').EmbeddedPending<import('../dist/embedded-client.js').EmbeddedRuntime> | null} */
  let reservation = null;
  // Preserve the original failure if an independent owned-cleanup step also fails.
  // 独立拥有型清理步骤也失败时保留原始失败。
  let failure = null;
  try {
    assert.deepEqual(transport.coreDescription, description, "Loaded candidate differs from the frozen core description");
    driver = new EmbeddedCommandDriver(transport, { workThreads: 1, maxWorkCommands: 4, maxControlCommands: 4 });
    await driver.ready();
    // The typed facade borrows this exact driver for every receipt.
    // 类型化入口为每个回执借用此精确驱动器。
    const client = new EmbeddedClient(driver);
    reservation = client.reserve();
    try {
      // Native identity receipt remains discoverable until the actual slot removal is proven.
      // 在实际槽移除获证前，原生身份回执保持可发现。
      runtime = await reservation.result();
    } catch (error) {
      if (error instanceof EmbeddedResultReleaseError) {
        try {
          // Recover only the same copied typed receipt; never allocate another runtime to replace it.
          // 仅恢复同一复制类型回执；绝不分配另一运行时替换它。
          runtime = reservation.deliveredResult();
        } catch (recoveryError) {
          // Retain the live driver and receipt when no exact identity is recoverable; preserve both diagnostics.
          // 无法恢复精确身份时保留存活驱动器及回执；保留两个诊断。
          throw new AggregateError([error, recoveryError], "Reserved runtime identity could not be recovered; original driver ownership remains live", { cause: error });
        }
      }
      throw error;
    }
    root = mkdtempSync(join(tmpdir(), "luaskills-embedded-policy-"));
    // Immutable host-assigned identity owns this demonstration's sole module generation.
    // 不可变宿主分配身份拥有此演示的唯一模块代次。
    const pluginId = "typescript-embedded-example";
    // Authorize a generation outside the legacy System root.
    // 授权旧 System 根之外的代次。
    const packageRoot = join(root, "plugin-generations", pluginId);
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(join(packageRoot, "dependencies.yaml"), "{}\n");
    // Plugin limits are derived from the same runtime declaration rather than independently duplicated.
    // 插件限制从同一运行时声明派生，不独立重复定义。
    const limits = { max_registered_plugins: 1, max_registered_pools: 1, max_sessions: 1, max_registered_capabilities: 1, max_resident_vms: 1, max_running_calls: 1, max_queued_calls: 4, max_queued_bytes: 4096, max_operations: 8, max_effect_records_per_operation: 8, max_effect_bytes_per_operation: 8192, max_host_requests: 4, max_host_request_bytes: 8192, max_value_bytes: 1024 };
    // Engine construction is explicit and prohibits network package downloads.
    // 引擎构造显式禁止网络包下载。
    const options = createEngineOptions({ runtimeRoot: root, hostOptions: { system_lua_lib_dir: join(root, "system_lua_lib"), allow_network_download: false } });
    await consume(runtime.initialize(options, limits));
    assert.equal((await consume(runtime.status())).initialization, "ready");
    // A pump requires the proven initialized runtime; adopt it before admitting module initialization.
    // 泵要求已获证明的就绪运行时；接纳模块初始化前接管它。
    pump = new EmbeddedCallbackPump(transport, runtime.runtimeId, { maxConcurrentHandlers: 1, maxPendingCommands: 2, pollIntervalMs: 2 });
    scope = new EmbeddedRuntimeScope(runtime, { pump, pollIntervalMs: 2 });
    await scope.ready();
    await pump.ready();
    await consume(runtime.registerPlugin(pluginId, { max_registered_pools: limits.max_registered_pools, max_sessions: limits.max_sessions, max_resident_vms: limits.max_resident_vms, max_running_calls: limits.max_running_calls, max_queued_calls: limits.max_queued_calls, max_queued_bytes: limits.max_queued_bytes, max_operations: limits.max_operations }));
    await pump.register([new HostCapability({ name: "typescript.example.echo", version: "1.0.0", description: "Return the original application value through a queued host callback", input_schema: true, output_schema: true, execution: "queued", permissions: ["typescript.example.host"], scope: "invocation", max_concurrent: 1, max_call_ms: nativeTimeoutMs, max_input_bytes: limits.max_value_bytes, max_output_bytes: limits.max_value_bytes, effects: "mutating", idempotency: "none" },
      // Record each exact request and actual commit; only unsafe asks for an integer outside Lua's exact range.
      // 记录每个精确请求及实际提交；仅 unsafe 要求超出 Lua 精确范围的整数。
      (value, context) => { callbackCount += 1; requests.push(context.requestId); context.reportEffects("committed"); return value === "unsafe" ? 18446744073709551615n : value; })]);
    /** Frozen module declaration with one initialized export.
     * 含一个已初始化导出的冻结模块声明。
     * @type {import('../dist/embedded-contract.js').InputModuleDefinition} */
    const definition = { plugin_id: pluginId, generation: "typescript-example-generation-1", package_root: packageRoot, dependencies_file: "dependencies.yaml", workspace_root: null, cwd: null, mounts: {}, security_partition: "typescript-example", source: `
-- Require actual initialization callback delivery before exposing the export.
-- 暴露导出前要求真实初始化回调交付。
local initialized = vulcan.host.call('typescript.example.echo', 'initialization')
assert(initialized.ok and initialized.value == 'initialization')
return {
  -- Return the full capability envelope so committed value rejection remains observable.
  -- 返回完整能力信封，使已提交值拒绝保持可观察。
  call = function(arguments)
    local reply = vulcan.host.call('typescript.example.echo', arguments)
    return reply
  end
}`, exports: [{ name: "call", input_schema: true, output_schema: true }] };
    /** Reusable policy derives its admission ceilings from the runtime limits.
     * 复用策略从运行时限制派生入场上限。
     * @type {import('../dist/embedded-contract.js').InputPluginPoolConfig} */
    const policy = { kind: "shared", min_resident_vms: 0, max_resident_vms: limits.max_resident_vms, max_running_calls: limits.max_running_calls, max_queued_calls: limits.max_queued_calls, reuse: "reusable", serial: false, backend: "in_process", idle_ttl_ms: null, max_uses: null };
    // Registration grants an exact host permission and narrows source initialization to its declared capability.
    // 注册授予精确宿主权限，将源码初始化收窄到声明能力。
    const pool = await consume(runtime.registerPool(definition, policy, ["typescript.example.host"], "example-v1", ["typescript.example.echo"]));
    // No request metadata is required by this local demonstration.
    // 此本地演示不需要请求元数据。
    const invocation = { request_context: null, client_budget: null, tool_config: null };
    // Reject integer tokens recursively before source initialization can call the host.
    // 在源码初始化调用宿主前递归拒绝整数 token。
    for (const value of [9007199254740992n, -9007199254740992n, { nested: [18446744073709551615n] }]) {
      // Observe and release the original rejected receipt without retrying admission.
      // 观察及释放原始被拒绝回执，不重试入场。
      const rejected = pool.submit("call", value, invocation, nativeTimeoutMs);
      try { await assert.rejects(rejected.result(), (error) => error instanceof EmbeddedRuntimeError && error.code === "invalid_argument"); }
      finally { rejected.forget(); }
    }
    assert.equal(callbackCount, 0, "Rejected values must not initialize Lua or call a host handler");
    assert.deepEqual((await consume(runtime.listOperations(pool.poolId, null, 8))).operation_ids, []);
    // Safe endpoints and explicitly declared finite Float values traverse the real Lua callback.
    // 安全端点及显式有限 Float 值经过真实 Lua 回调。
    for (const value of [9007199254740991, -9007199254740991, new EmbeddedFloat(9007199254740992), new EmbeddedFloat(1e100)]) {
      // Exact admitted operation and its terminal snapshot share one identity.
      // 精确已入场操作及其终态快照共享一个身份。
      const operation = await consume(pool.submit("call", value, invocation, nativeTimeoutMs));
      const done = await operation.wait({ signal: AbortSignal.timeout(observerTimeoutMs) });
      assert.equal(done.phase, "succeeded");
      assert.equal(done.value.ok, true);
      assert.deepEqual(done.value.value, value);
      await consume(operation.forget());
    }
    // Host completion acknowledges actual commit even when its result cannot enter Lua.
    // 即使结果无法进入 Lua，宿主完成仍确认实际提交。
    const unsafe = await consume(pool.submit("call", "unsafe", invocation, nativeTimeoutMs));
    const failedValue = await unsafe.wait({ signal: AbortSignal.timeout(observerTimeoutMs) });
    assert.equal(failedValue.phase, "succeeded");
    // Overall Lua execution remains unknown, independently of the exact callback's committed evidence.
    // 整体 Lua 执行保持未知，独立于精确回调的已提交证据。
    assert.equal(failedValue.effects, "unknown");
    assert.equal(failedValue.value.ok, false);
    assert.equal(failedValue.value.error.code, "invalid_argument");
    assert.equal(failedValue.value.effects, "committed");
    // Lookup uses the exact latest handler identity, independent of ledger ordering.
    // 查找使用精确最近处理器身份，独立于账本排序。
    const effect = failedValue.host_effects.find((entry) => entry.request_id === requests.at(-1));
    assert.ok(effect, "Original callback ledger identity is missing");
    assert.equal(effect.phase, "completed");
    assert.equal(effect.effects, "committed");
    await consume(unsafe.forget());
    // Subsequent normal delivery and exact counts prove no poisoned owner or callback replay.
    // 后续正常交付及精确计数证明所有者未受损且回调未重播。
    const normal = await consume(pool.submit("call", "normal", invocation, nativeTimeoutMs));
    assert.equal((await normal.wait({ signal: AbortSignal.timeout(observerTimeoutMs) })).value.value, "normal");
    await consume(normal.forget());
    assert.equal(callbackCount, 7, "Initialization and six business callbacks execute once each");
    await scope.close({ signal: AbortSignal.timeout(observerTimeoutMs) });
    assert.equal(scope.status.phase, "closed");
    assert.equal(pump.status.closed, true);
    assert.equal(pump.status.failure, null);
    assert.deepEqual(pump.status.requestIds, []);
    assert.deepEqual(pump.status.pendingAcknowledgements, []);
    assert.equal(EmbeddedRuntimeScope.live.includes(scope), false);
    // Actual slot removal is stronger evidence than a shutdown acknowledgement.
    // 实际槽移除比关闭确认提供更强证据。
    const removed = runtime.status();
    await assert.rejects(removed.result(), (error) => error instanceof EmbeddedRuntimeError && error.code === "not_found");
    removed.forget();
    return { core_version: description.core_version, protocol_version: description.protocol_version, contract_sha256: description.build.contract_sha256, callback_count: callbackCount, scope: scope.status.phase };
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    // Do not discard files or native owners after failed cleanup; retain the original lifecycle evidence.
    // 清理失败后不丢弃文件或原生所有者；保留原始生命周期证据。
    // An unprojected reservation remains discoverable through the live driver; closing it would hide its owner.
    // 未投影预留仍可通过存活驱动器发现；关闭驱动器会隐藏其所有者。
    try {
      if (reservation === null || runtime !== null) {
        if (driver !== null) await driver.releaseResults();
        if (runtime !== null && scope === null) scope = new EmbeddedRuntimeScope(runtime, pump === null ? {} : { pump });
        if (scope !== null) await scope.close();
        // Only a successfully closed scope proves the original slot was removed; earlier failures retain its receipt.
        // 仅成功关闭的作用域证明原槽已移除；此前失败保留其回执。
        if (reservation !== null) reservation.forget();
        if (driver !== null) { await driver.close(); assert.equal(driver.status.closed, true); }
        transport.releaseResults();
        transport.close();
        transport.free();
        assert.equal(transport.transportId, null);
        if (root !== null) rmSync(root, { recursive: true, force: true });
      }
    } catch (cleanupError) {
      if (failure !== null && cleanupError !== failure) throw new AggregateError([failure, cleanupError], "Embedded example failed and owned cleanup did not complete; original driver receipt remains live", { cause: failure });
      throw cleanupError;
    }
  }
}
