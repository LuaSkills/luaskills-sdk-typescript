import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { EmbeddedClient, EmbeddedCommandDriver, EmbeddedCallbackPump, EmbeddedTransport, EmbeddedRuntimeError, EmbeddedResultReleaseError, EmbeddedNativeStatus, HostCapability, createEngineOptions } from "../dist/index.js";
import { budgets, withRuntime, poll } from "./embedded-fixture.mjs";

// Real lifecycle and Lua checks require the explicitly selected matching development core.
// 真实生命周期及 Lua 校验要求显式选择匹配的开发核心。
const native = { skip: !process.env.LUASKILLS_LIB };
const driverConfig = Object.freeze({ workThreads: 1, maxWorkCommands: 4, maxControlCommands: 4 });
const invocation = Object.freeze({ request_context: null, client_budget: null, tool_config: null });

/**
 * Consume an explicitly successful test receipt; a failed observation leaves its original evidence retained.
 * 消费明确成功的测试回执；观察失败时保留其原始证据。
 * @param {object} pending Exact typed pending command.
 * 精确类型化待完成命令。
 * @returns {Promise<unknown>} The projected native delivery.
 * 投影的原生交付结果。
 */
async function consume(pending) { const result = await pending.result(); pending.forget(); return result; }

/**
 * Borrow a typed client from the existing fixture's owned driver.
 * 从现有夹具拥有的驱动器借用类型化客户端。
 * @param {Function} action Body receiving real fixture state and an exact typed runtime handle.
 * 接收真实夹具状态及精确类型化运行时句柄的测试主体。
 * @returns {Promise<void>} Completion after the existing native fixture cleanup.
 * 现有原生夹具清理完成之后结束。
 */
async function withClient(action) {
  await withRuntime(async (fixture) => {
    const client = new EmbeddedClient(fixture.driver);
    await action({ ...fixture, client, runtime: client.runtime(fixture.runtimeId) });
  }, { driverConfig });
}

// Explicit prewarming creates distinct real instances and preserves ordinary operation receipts and close fencing.
// 明确预热创建不同真实实例，并保留普通操作回执及关闭围栏。
test("typed prewarm creates additional VMs without calling business exports", native, async () => {
  await withClient(async ({ runtime, moduleDefinition, poolPolicy }) => {
    // The local counter can change only when ordinary business is invoked after prewarming.
    // 仅预热之后调用普通业务时，本地计数器才可变化。
    const pool = await consume(runtime.registerPool(moduleDefinition(
      "local count=0; return {call=function() count=count+1; return count end}"), poolPolicy, [], "prewarm-v1"));
    const instances = new Set();
    for (let index = 0; index < poolPolicy.max_resident_vms; index += 1) {
      // Keep the delivered command distinct from its asynchronously completed native operation.
      // 将已交付命令与其异步完成的原生操作保持分离。
      const pending = pool.prewarmInstance(invocation, 5000);
      assert.equal(pending.receipt.lane, "work");
      const operation = await consume(pending);
      const result = await operation.wait();
      assert.equal(result.phase, "succeeded", JSON.stringify(result));
      assert.equal(result.context.kind, "module");
      assert.equal(result.context.prewarm, true);
      assert.equal(result.context.export, null);
      assert.equal(result.context.pool_id, pool.poolId);
      assert.equal(typeof result.value.instance_id, "string");
      assert.equal(instances.has(result.value.instance_id), false);
      instances.add(result.value.instance_id);
      await consume(operation.forget());
    }
    assert.equal((await consume(pool.status())).resident, instances.size);
    // Full-pool prewarming fails as a queryable operation; subsequent ordinary reuse must still progress.
    // 满池预热以可查询操作失败；后续普通复用仍必须推进。
    const rejected = await consume(pool.prewarmInstance(invocation, 5000));
    const failure = await rejected.wait();
    assert.equal(failure.phase, "failed");
    assert.equal(failure.error.code, "capacity_exceeded");
    await consume(rejected.forget());
    for (const count of [1, 2]) {
      const business = await consume(pool.submit("call", null, invocation, 5000));
      assert.equal((await business.wait()).value, count);
      await consume(business.forget());
    }
    await consume(pool.requestClose());
    const closed = pool.prewarmInstance(invocation, 5000);
    await assert.rejects(closed.result(), (error) => error.code === "closed");
    closed.forget();
  });
});

// Exact native policy revisions remain reachable when work receipts and VM capacity are exhausted.
// 精确原生策略修订在工作回执及 VM 容量耗尽时仍可达。
test("typed capacity revisions preserve pinned state and control admission", native, async () => {
  await withClient(async ({ runtime, runtimeConfig, pluginId, moduleDefinition, poolPolicy }) => {
    // The explicit capacity derives its ceilings from the actual native fixture.
    // 显式容量从实际原生夹具派生上限。
    const config = { resources: { kind: "shared", min_resident_vms: 0,
      max_resident_vms: runtimeConfig.max_resident_vms, max_running_calls: 1 },
      max_queued_calls: runtimeConfig.max_queued_calls, max_queued_bytes: runtimeConfig.max_queued_bytes };
    // Keep one exact capacity identity across all accepted and rejected commands.
    // 在全部被接纳及拒绝命令中保持同一精确容量身份。
    const capacity = await consume(runtime.registerCapacity(pluginId, config));
    // Each fixed instance owns independent state even after its aggregate budget changes.
    // 即使聚合预算变化，各固定实例仍拥有独立状态。
    const definition = moduleDefinition(`-- Retain private state in this fixed VM.
-- 在此固定 VM 中保留私有状态。
local count=0
return {
-- Advance this instance's counter.
-- 递增此实例的计数器。
call=function() count=count+1; return count end}`);
    // The module declaration stays immutable across later capacity revisions.
    // 模块声明在后续容量修订中保持不可变。
    const pool = await consume(capacity.registerPool(definition,
      { ...poolPolicy, ...config.resources, reuse: "session" }, [], "policy-v1"));
    // All original sessions remain bound to their original real VM.
    // 全部原会话保持绑定各自原真实 VM。
    const sessions = [];
    for (let index = 0; index < config.resources.max_resident_vms; index += 1) {
      // Session reservation alone does not prove initialization success.
      // 仅会话预留不能证明初始化成功。
      const opening = await consume(pool.openSession(5000));
      assert.equal((await opening.initialization.wait()).phase, "succeeded");
      await consume(opening.initialization.forget());
      sessions.push(opening.session);
    }
    // Failed retained work receipts consume the configured lane without allocating extra VMs.
    // 失败保留工作回执消费配置通道，不分配额外 VM。
    const held = [];
    for (let index = 0; index < driverConfig.maxWorkCommands; index += 1) {
      // Keep native capacity rejection observable until the explicit release below.
      // 下方明确释放前，保持原生容量拒绝可观察。
      const rejected = pool.openSession(5000);
      await assert.rejects(rejected.result(), (error) => error.code === "capacity_exceeded");
      held.push(rejected);
    }
    assert.throws(() => pool.openSession(5000), {
      name: "RangeError", message: "Embedded work command receipt capacity exceeded",
    });
    // Atomic query and revision must bypass the saturated work lane.
    // 原子查询及修订必须避开已饱和工作通道。
    const query = capacity.policy();
    assert.equal(query.receipt.lane, "control");
    // Preserve the original opaque predecessor without numeric conversion.
    // 保留原不透明前驱，不进行数值转换。
    const before = await consume(query);
    assert.equal(typeof before.revision, "string");
    // The original two pinned VMs exceed this valid dedicated target.
    // 原两个固定 VM 超过此合法专用目标。
    const target = { ...config, resources: { ...config.resources, kind: "dedicated",
      min_resident_vms: 1, max_resident_vms: 1 } };
    // Mutation is short control work but still respects native shutdown fencing.
    // 变更是短时控制工作，但仍遵守原生关闭屏障。
    const change = capacity.revise(before.revision, target);
    assert.equal(change.receipt.lane, "control");
    // Only native acknowledgement proves policy publication.
    // 仅原生确认能证明策略发布。
    const revision = await consume(change);
    assert.equal(typeof revision, "string");
    assert.notEqual(revision, before.revision);
    // A stale request never silently retries against another writer's policy.
    // 过期请求绝不针对另一写入者的策略静默重试。
    const stale = capacity.revise(before.revision, config);
    await assert.rejects(stale.result(), (error) => error.code === "busy");
    stale.forget();
    // Current status retains real occupancy rather than reporting the smaller desired amount.
    // 当前状态保留真实占用，不报告更小期望数量。
    const pending = await consume(capacity.policy());
    assert.equal(pending.revision, revision);
    assert.deepEqual(pending.capacity.config, target);
    assert.equal(pending.capacity.resources.resident, sessions.length);
    assert.equal(pending.pending_convergence, true);
    for (const receipt of held) receipt.forget();
    for (const session of sessions) {
      for (const expected of [1, 2]) {
        // The original fixed state survives the quota shrink.
        // 原固定状态在额度缩减后保留。
        const operation = await consume(session.submit("call", null, invocation, 5000));
        assert.equal((await operation.wait()).value, expected);
        await consume(operation.forget());
      }
      await consume(session.requestClose());
    }
    await poll(() => consume(capacity.policy()), (status) => status.capacity.resources.resident === 0);
    assert.equal((await consume(capacity.policy())).pending_convergence, false);
    await consume(runtime.requestClose());
    assert.equal((await consume(capacity.policy())).capacity.closing, true);
    // Read access survives closure while revisions cannot reopen the parent.
    // 读取权限跨关闭保留，而修订不能重开父级。
    const closed = capacity.revise(revision, config);
    await assert.rejects(closed.result(), (error) => error.code === "closed");
    closed.forget();
  });
});

// Actual native capacity handles preserve per-module state and release only after member retirement.
// 实际原生容量句柄保留各模块状态，仅在成员退役后释放。
test("typed capacity owns isolated members and explicit release", native, async () => {
  await withClient(async ({ runtime, pluginId, moduleDefinition, poolPolicy }) => {
    // One aggregate reservation backs two independent reusable module instances.
    // 单个聚合预留支持两个独立可复用模块实例。
    const config = { resources: { kind: "dedicated", min_resident_vms: 1, max_resident_vms: 2, max_running_calls: 1 },
      max_queued_calls: poolPolicy.max_queued_calls, max_queued_bytes: 4096 };
    // Registration returns an exact acknowledged native identity.
    // 注册返回精确已确认原生身份。
    const capacity = await consume(runtime.registerCapacity(pluginId, config));
    assert.equal(runtime.capacity(capacity.capacityId).capacityId, capacity.capacityId);
    // Capacity status must remain on the reserved control worker.
    // 容量状态必须保持在预留控制工作线程上。
    const initial = capacity.status();
    assert.equal(initial.receipt.lane, "control");
    assert.equal((await consume(initial)).committed_resident_vms, 1);
    // Both member handles remain distinct through closure and explicit forgetting.
    // 两个成员句柄跨关闭及显式遗忘保持不同。
    const pools = [];
    for (const revision of ["first", "second"]) {
      // Module-local counters expose accidental cross-member reuse.
      // 模块局部计数器暴露意外跨成员复用。
      const definition = moduleDefinition(`-- Keep state private to the original module.
-- 将状态保持在原模块内。
local count=0
-- Return the next count without arguments or external effects.
-- 返回下一个计数，不使用参数或产生外部副作用。
return {call=function() count=count+1; return count end}`);
      definition.generation = revision;
      pools.push(await consume(capacity.registerPool(definition,
        { ...poolPolicy, kind: "dedicated", min_resident_vms: 0, max_resident_vms: 1, max_running_calls: 1 }, [], revision)));
    }
    for (const pool of pools) {
      for (const expected of [1, 2]) {
        // Observe the actual Lua result and release only its completed operation record.
        // 观测实际 Lua 结果，仅释放已完成操作记录。
        const operation = await consume(pool.submit("call", null, invocation, 5000));
        assert.equal((await operation.wait()).value, expected);
        await consume(operation.forget());
      }
    }
    assert.equal((await consume(capacity.status())).resources.resident, 2);
    await consume(capacity.requestClose());
    // Busy keeps the original capacity visible while members remain retained.
    // 成员仍保留时，忙碌保持原容量可见。
    const blocked = capacity.forget();
    await assert.rejects(blocked.result(), (error) => error.code === "busy");
    blocked.forget();
    await poll(() => consume(capacity.status()), (status) => status.resources.resident === 0);
    for (const pool of pools) await consume(pool.forget());
    assert.equal((await consume(capacity.status())).committed_resident_vms, 1);
    await consume(capacity.forget());
    assert.equal((await consume(runtime.plugin(pluginId).status())).committed_resident_vms, 0);
  });
});

test("invalid polling bounds and already-aborted observation submit no commands", async () => {
  let submissions = 0;
  const client = new EmbeddedClient({ submit() { submissions += 1; throw new Error("Unexpected command"); } });
  const operation = client.runtime("known-runtime").operation("known-operation");
  for (const pollIntervalMs of [0, -1, 0.5, true, NaN, Infinity, 2147483648]) await assert.rejects(operation.wait({ pollIntervalMs }), RangeError);
  const failure = new Error("observer cancelled before entry");
  await assert.rejects(operation.wait({ signal: AbortSignal.abort(failure) }), (error) => error === failure);
  assert.equal(submissions, 0);
});

test("distributed facade declarations preserve generated options, immutable identities and exact handle results", () => {
  const compiler = createRequire(import.meta.url).resolve("typescript/bin/tsc");
  const fixture = fileURLToPath(new URL("./fixtures/embedded-client-consumer.ts", import.meta.url));
  const result = spawnSync(process.execPath, [compiler, "--strict", "--exactOptionalPropertyTypes", "--noEmit", "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext", fixture], { encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
});

// Real durable calls retain their original context while metadata and history have separate lifetimes.
// 真实持久调用保留原上下文，元数据和历史拥有独立寿命。
test("typed durable history retains exact context and unresolved evidence", native, async () => {
  await withRuntime(async ({ driver, runtimeId, moduleDefinition, poolPolicy }) => {
    // The facade uses the exact initialized native slot owned by this fixture.
    // 外观使用此夹具拥有的精确已初始化原生槽。
    const runtime = new EmbeddedClient(driver).runtime(runtimeId);
    // Original core namespace is the history key, not the transport-local slot identity.
    // 原核心命名空间是历史键，而非传输局部槽身份。
    const status = await consume(runtime.status());
    assert.notEqual(status.persistence, null);
    assert.equal(await consume(runtime.recoverStorage()), false);
    assert.equal(await consume(runtime.recoverStorageWorker()), false);
    assert.equal((await consume(runtime.storageStatus())).closing, false);
    // No callback is needed to bind and retain admission context.
    // 绑定并保留入场上下文不需要回调。
    const pool = await consume(runtime.registerPool(moduleDefinition("return {call=function(a) return a end}"), poolPolicy, [], "durable-ts-v1"));
    // Preserve the original admitted operation and terminal value.
    // 保留原入场操作与终态值。
    const operation = await consume(pool.submit("call", { durable: "中文" }, invocation, 10000));
    // Terminal publication requires native durable confirmation.
    // 终态发布需要原生持久确认。
    const done = await operation.wait();
    assert.equal(await consume(operation.persistenceFailure()), null);
    // Retry without a failure must be rejected rather than replaying business work.
    // 没有故障的重试必须被拒绝，不能重放业务工作。
    const retry = operation.retryCheckpoint();
    await assert.rejects(retry.result(), (error) => error.code === "busy");
    retry.forget();
    // Compare the entire persisted snapshot and original namespace.
    // 比较整个持久快照与原命名空间。
    const history = await consume(runtime.historyGet(status.core_runtime_id, operation.operationId));
    assert.deepEqual(history.snapshot, done);
    assert.deepEqual(await consume(runtime.historyNext()), history);
    assert.equal(await consume(runtime.historyNext({ runtime_id: history.runtime_id, operation_id: operation.operationId })), null);
    // This exact fixture has been inspected by the host; successful execution alone is not audit evidence.
    // 此精确夹具已由宿主检查；仅成功执行不是审计证据。
    const resolution = { resolution_id: "typescript-audit", resolver: "trusted-test-host",
      evidence: "fixture:pure-source-and-stopped-owner", execution: "observed_terminal",
      effects: "not_applicable", host_effects: [] };
    // Retained terminal owners still forbid administrative finalization.
    // 仍保留的终态所有者继续禁止管理最终对账。
    const blocked = runtime.historyReconcile(history.runtime_id, operation.operationId, history.revision, resolution);
    await assert.rejects(blocked.result(), (error) => error.code === "busy");
    blocked.forget();
    await consume(operation.forget());
    // Ordinary Lua success does not reconcile all possible external effects.
    // 普通 Lua 成功不表示所有可能外部副作用均已对账。
    const deletion = runtime.historyForget(history.runtime_id, operation.operationId, history.revision);
    await assert.rejects(deletion.result(), (error) => error.code === "busy");
    deletion.forget();
    assert.deepEqual(await consume(runtime.historyGet(history.runtime_id, operation.operationId)), history);
    // Retry exactly the original predecessor and proof; only one successor may become durable.
    // 精确重试原前驱及证明；只允许一个后继持久化。
    const revision = await consume(runtime.historyReconcile(history.runtime_id, operation.operationId, history.revision, resolution));
    assert.equal(BigInt(revision), BigInt(history.revision) + 1n);
    assert.equal(await consume(runtime.historyReconcile(history.runtime_id, operation.operationId, history.revision, resolution)), revision);
    // Preserve unknown original observations alongside separate resolved host evidence.
    // 在独立宿主已解决证据旁保留原始未知观测。
    const reconciled = await consume(runtime.historyGet(history.runtime_id, operation.operationId));
    assert.deepEqual(reconciled.snapshot, history.snapshot);
    assert.deepEqual(reconciled.reconciliation, resolution);
    await consume(runtime.historyForget(history.runtime_id, operation.operationId, revision));
    assert.equal(await consume(runtime.historyGet(history.runtime_id, operation.operationId)), null);
  }, { driverConfig, persistent: true });
});

test("persistent callback capacity failure requires explicit original checkpoint retry without replay", native, async () => {
  await withRuntime(async ({ driver, transport, runtimeId, moduleDefinition, poolPolicy }) => {
    // Bind the actual slot and reserve an independent callback worker while persistence is enabled.
    // 绑定实际槽，并在启用持久化时预留独立回调线程。
    const runtime = new EmbeddedClient(driver).runtime(runtimeId);
    // Every actual callback entry records its original operation identity.
    // 每次实际回调进入均记录其原操作身份。
    const calls = [];
    // The fixture drains this callback owner before its native runtime.
    // 夹具在原生运行时之前排空此回调所有者。
    const pump = new EmbeddedCallbackPump(transport, runtimeId, { maxConcurrentHandlers: 1, maxPendingCommands: 1, pollIntervalMs: 2 });
    /** Read optional checkpoint failure after explicit busy observation clears; mutate no business state.
     * 明确忙碌观察清除后读取可空检查点故障；不变更业务状态。
     * @param {object} operation Original live operation handle.
     * 原活动操作句柄。
     * @returns {Promise<object|null>} Actual failure or healthy absence.
     * 实际故障或健康缺失。 */
    const availableFailure = async (operation) => {
      // Wrap null so completed absence remains distinct from the busy polling marker.
      // 包装空值，使完成的缺失保持区别于忙碌轮询标记。
      const observed = await poll(async () => {
        // Explicitly release each completed query, including a busy error.
        // 显式释放每个完成查询，包括忙碌错误。
        const pending = operation.persistenceFailure();
        try { return { failure: await pending.result() }; }
        catch (error) { if (error.code === "busy") return null; throw error; }
        finally { pending.forget(); }
      }, (observation) => observation !== null);
      return observed.failure;
    };
    try {
      await pump.ready();
      // Only this host-owned descriptor enters the captured pool capability snapshot.
      // 仅此宿主自有描述进入捕获的池能力快照。
      const descriptor = { name: "durable.callback", version: "1.0.0", description: "Persistent capacity recovery fixture", input_schema: true, output_schema: true, execution: "queued", permissions: ["typescript.host"], scope: "invocation", max_concurrent: 1, max_call_ms: 10000, max_input_bytes: 1024, max_output_bytes: 1024, effects: "mutating", idempotency: "none" };
      await pump.register([new HostCapability(descriptor, async (argumentsValue, context) => {
        calls.push(context.caller.operation_id);
        context.reportEffects("committed");
        return argumentsValue;
      })]);
      // First success fills the one-record journal through a real JavaScript callback.
      // 首次成功通过真实 JavaScript 回调填满单记录日志。
      const pool = await consume(runtime.registerPool(moduleDefinition("return {call=function(a) local r=vulcan.capabilities.call('durable.callback',a); return r.value end}"), poolPolicy, ["typescript.host"], "durable-capacity"));
      // Retain exact original operation identity separately from transient command receipts.
      // 独立于瞬态命令回执保留精确原操作身份。
      const first = await consume(pool.submit("call", "committed-once", invocation, 10000));
      // The actual terminal checkpoint includes the callback's confirmed evidence.
      // 实际终态检查点包含回调已确认的证据。
      const firstDone = await first.wait();
      // Native status is the namespace authority.
      // 原生状态是命名空间权威。
      const namespace = (await consume(runtime.status())).core_runtime_id;
      // Keep the durable row after releasing only live metadata.
      // 仅释放活动元数据后保留持久行。
      const history = await consume(runtime.historyGet(namespace, first.operationId));
      await consume(first.forget());
      // No capacity remains for this separate operation's execution intent.
      // 此独立操作的执行意图已无剩余容量。
      const second = await consume(pool.submit("call", "must-not-run", invocation, 10000));
      // Query the control lane until it exposes the actual retained storage failure.
      // 查询控制通道，直至暴露实际保留的存储故障。
      const failure = await poll(() => availableFailure(second), (failure) => failure !== null);
      // The host inspected the callback-only fixture source and observed the actual first handler's completion.
      // 宿主检查了仅含回调的夹具源码，并观测实际首处理器完成。
      const resolution = { resolution_id: "capacity-audit", resolver: "trusted-test-host", evidence: "fixture:joined-callback-and-no-other-effects", execution: "observed_terminal", effects: "committed", host_effects: history.snapshot.host_effects.map((effect) => ({ effect_id: effect.effect_id, effects: "committed", evidence: "fixture:actual-handler-completed" })) };
      // Repair capacity through public work commands while the failed operation remains owned.
      // 失败操作仍被拥有时，通过公开工作命令修复容量。
      const revision = await consume(runtime.historyReconcile(namespace, first.operationId, history.revision, resolution));
      await consume(runtime.historyForget(namespace, first.operationId, revision));
      // Capacity repair does not automatically retry the original checkpoint.
      // 修复容量不自动重试原检查点。
      const repairedFailure = await availableFailure(second);
      // Only persistence is retried; the original business failure remains the result.
      // 仅重试持久化；原业务失败仍为结果。
      const requested = await consume(second.retryCheckpoint());
      // Waiting observes the exact same operation after its original checkpoint is durable.
      // 等待观测原检查点持久化后的精确同一操作。
      const done = await second.wait();
      assert.equal(firstDone.value, "committed-once");
      assert.deepEqual(history.snapshot, firstDone);
      assert.equal(firstDone.host_effects.length, 1);
      assert.ok(firstDone.host_effects.every((effect) => effect.effects === "committed"));
      assert.deepEqual(calls, [first.operationId]);
      assert.equal(failure.operation_id, second.operationId);
      assert.equal(failure.error.code, "capacity_exceeded");
      assert.equal(failure.retry, "waiting");
      assert.deepEqual(repairedFailure, failure);
      assert.equal(requested, true);
      assert.equal(done.phase, "failed");
      assert.equal(done.error.code, "capacity_exceeded");
      // Retirement of an already initialized VM conservatively retains unknown aggregate effects.
      // 已初始化 VM 退役保守地保留未知聚合副作用。
      assert.equal(done.effects, "unknown");
      assert.deepEqual(done.host_effects, []);
      assert.equal(await availableFailure(second), null);
      // The trusted fixture host also verified this VM's retirement has no additional external effects.
      // 可信夹具宿主也核实此 VM 退役没有额外外部副作用。
      const failedHistory = await consume(runtime.historyGet(namespace, second.operationId));
      assert.deepEqual(failedHistory.snapshot, done);
      await consume(second.forget());
      // Final audit leaves the original failed result unchanged.
      // 最终审计保留原失败结果不变。
      const failedRevision = await consume(runtime.historyReconcile(namespace, second.operationId, failedHistory.revision, { resolution_id: "failed-capacity-audit", resolver: "trusted-test-host", evidence: "fixture:retired-vm-without-finalizers-or-new-effects", execution: "observed_terminal", effects: "not_applicable", host_effects: [] }));
      await consume(runtime.historyForget(namespace, second.operationId, failedRevision));
    } finally { await pump.close(); }
  }, { driverConfig, persistent: true, journalMaxRecords: 1 });
});

test("typed shared pools preserve native values, errors, accounting and separate receipt forgetting", native, async () => {
  await withClient(async ({ runtime, driver, moduleDefinition, poolPolicy, pluginConfig }) => {
    const plugin = await consume(runtime.registerPlugin("typescript-second", pluginConfig));
    const definition = { ...moduleDefinition("local n=0; return {call=function(a) if a=='fail' then error('expected typed failure') end n=n+1; return {n=n,a=a} end}"), plugin_id: plugin.pluginId };
    const pool = await consume(runtime.registerPool(definition, poolPolicy, [], "typescript-typed-v1"));
    for (const [index, value] of [null, false].entries()) {
      const submission = pool.submit("call", value, invocation, 10000);
      const operation = await submission.result();
      assert.ok(driver.commands.includes(submission.receipt));
      submission.forget();
      const result = await operation.wait();
      assert.equal(result.phase, "succeeded");
      assert.deepEqual(result.value, { n: index + 1, a: value });
      assert.equal(result.context.kind, "module");
      assert.equal(result.context.pool_id, pool.poolId);
      assert.equal(result.context.caller.plugin_id, definition.plugin_id);
      assert.equal(result.context.caller.package_generation, definition.generation);
      assert.equal(result.context.caller.operation_id, operation.operationId);
      assert.equal(result.context.export, "call");
      assert.deepEqual(result.host_effects, []);
      assert.equal((await consume(operation.status())).operation_id, operation.operationId);
      await consume(operation.forget());
      const missing = operation.status();
      await assert.rejects(missing.result(), (error) => error instanceof EmbeddedRuntimeError && error.code === "not_found");
      missing.forget();
    }
    const failed = await consume(pool.submit("call", "fail", invocation, 10000));
    const snapshot = await failed.wait();
    assert.equal(snapshot.phase, "failed");
    assert.match(snapshot.error.message, /expected typed failure/);
    assert.equal(Object.hasOwn(snapshot, "value"), false);
    await consume(failed.forget());
    assert.equal((await consume(pool.status())).running, 0);
    assert.equal((await consume(plugin.status())).plugin_id, plugin.pluginId);
    await consume(pool.requestClose());
    await poll(() => consume(pool.status()), (usage) => usage.resident === 0);
    await consume(pool.forget());
    await consume(plugin.requestClose());
    await consume(plugin.forget());
    assert.equal(driver.commands.length, 0);
  });
});

test("typed dedicated fixed sessions preserve one Lua state through explicit close and forget", native, async () => {
  await withClient(async ({ runtime, moduleDefinition, poolPolicy }) => {
    const pool = await consume(runtime.registerPool(moduleDefinition("local n=0; return {call=function(a) n=n+1; return n end}"), { ...poolPolicy, kind: "dedicated", reuse: "session", serial: true, max_running_calls: 1 }, [], "typescript-session-v1"));
    const opened = await consume(pool.openSession(10000));
    // Opening retains a module context even before any exported operation or host callback exists.
    // 在任何导出操作或宿主回调存在前，开启操作已保留模块上下文。
    const initialized = await opened.initialization.wait();
    assert.equal(initialized.phase, "succeeded");
    assert.equal(initialized.context.kind, "module");
    assert.equal(initialized.context.caller.session_id, opened.session.sessionId);
    assert.equal(initialized.context.export, null);
    assert.equal((await consume(opened.session.status())).phase, "ready");
    for (const expected of [1, 2]) {
      const operation = await consume(opened.session.submit("call", null, invocation, 10000));
      // Read the actual pinned-session identity through the typed operation response.
      // 通过类型化操作响应读取真实固定会话身份。
      const completed = await operation.wait();
      assert.equal(completed.value, expected);
      assert.equal(completed.context.caller.session_id, opened.session.sessionId);
      assert.equal(completed.context.caller.operation_id, operation.operationId);
      assert.equal(completed.context.export, "call");
      await consume(operation.forget());
    }
    await consume(opened.initialization.forget());
    await consume(opened.session.requestClose());
    await poll(() => consume(opened.session.status()), (snapshot) => snapshot.phase === "closed");
    await consume(opened.session.forget());
    await consume(pool.requestClose());
    await poll(() => consume(pool.status()), (usage) => usage.resident === 0);
    await consume(pool.forget());
  });
});

test("typed status and operation observation retain the control lane while work receipts are full", native, async () => {
  await withClient(async ({ runtime, driver, pool: rawPool }) => {
    const operation = await consume(runtime.pool(rawPool("return {call=function(a) return a end}")).submit("call", "control-available", invocation, 10000));
    const occupied = Array.from({ length: driverConfig.maxWorkCommands }, () => driver.submit({ type: "describe" }, "work"));
    try {
      await Promise.all(occupied.map((receipt) => receipt.result()));
      assert.throws(() => driver.submit({ type: "describe" }, "work"), /receipt capacity/);
      assert.equal((await consume(runtime.status())).initialization, "ready");
      assert.equal((await operation.wait()).value, "control-available");
      assert.equal(driver.commands.length, occupied.length);
    } finally { for (const receipt of occupied) receipt.forget(); }
  });
});

test("cancelled reserve observation recovers one exact native identity without repeating admission", native, async () => {
  const transport = new EmbeddedTransport(budgets);
  const driver = new EmbeddedCommandDriver(transport, driverConfig);
  let runtime = null;
  try {
    await driver.ready();
    const client = new EmbeddedClient(driver);
    const pending = client.reserve();
    const failure = new Error("detached reserve observer");
    await assert.rejects(pending.result({ signal: AbortSignal.abort(failure) }), (error) => error === failure);
    assert.ok(driver.commands.includes(pending.receipt));
    runtime = await pending.result();
    assert.equal(pending.deliveredResult().runtimeId, runtime.runtimeId);
    assert.throws(() => { runtime.runtimeId = "replacement"; }, TypeError);
    pending.forget();
    assert.equal((await consume(runtime.status())).initialization, "reserved");
    await consume(runtime.requestClose());
    await consume(runtime.free());
    runtime = null;
  } finally {
    if (runtime !== null) { await consume(runtime.requestClose()); await consume(runtime.free()); }
    await driver.close();
    transport.close();
    transport.free();
  }
});

test("failed typed projection preserves its original real command receipt", native, async () => {
  await withClient(async ({ client, driver }) => {
    const failure = new Error("projection failure");
    const pending = client.describe().map(() => { throw failure; });
    await assert.rejects(pending.result(), (error) => error === failure);
    assert.ok(driver.commands.includes(pending.receipt));
    assert.equal(pending.receipt.deliveredResult().protocol_version, 1);
    assert.throws(() => pending.deliveredResult(), (error) => error === failure);
    pending.forget();
  });
});

test("premature runtime release is a retained business rejection rather than false closure", native, async () => {
  await withClient(async ({ runtime, driver }) => {
    const pending = runtime.free();
    await assert.rejects(pending.result(), (error) => error instanceof EmbeddedRuntimeError && error.code === "busy");
    assert.ok(driver.commands.includes(pending.receipt));
    pending.forget();
    const status = await consume(runtime.status());
    assert.equal(status.initialization, "ready");
    assert.equal(status.closing, false);
  });
});

test("typed admission recovers copied operation identity after a simulated release observation failure", native, async () => {
  await withClient(async ({ runtime, driver, pool: rawPool }) => {
    const original = driver.submit;
    let calls = 0;
    driver.submit = function (command, lane) {
      const receipt = original.call(this, command, lane);
      if (command.type !== "runtime" || command.operation.type !== "call_submit") return receipt;
      calls += 1;
      return { forget: receipt.forget.bind(receipt), deliveredResult: receipt.deliveredResult.bind(receipt), result: async () => {
        await receipt.result();
        // Actual allocation retention is covered by worker tests; this exercises only typed delivery recovery.
        // 实际分配保留由工作线程测试覆盖；此处仅验证类型交付恢复。
        throw new EmbeddedResultReleaseError(EmbeddedNativeStatus.BUSY, Buffer.from(receipt.responseBytes));
      } };
    };
    try {
      const pending = runtime.pool(rawPool("return {call=function(a) return a end}")).submit("call", null, invocation, 10000);
      await assert.rejects(pending.result(), EmbeddedResultReleaseError);
      const operation = pending.deliveredResult();
      pending.forget();
      assert.equal((await operation.wait()).value, null);
      assert.equal(calls, 1);
    } finally { driver.submit = original; }
  });
});

test("operation observer cancellation preserves live callbacks, rejects nested waits and retains late effects", native, async () => {
  await withClient(async ({ runtime, driver, transport, pool: rawPool, runtimeId }) => {
    const pump = new EmbeddedCallbackPump(transport, runtimeId, { maxConcurrentHandlers: 1, maxPendingCommands: 1, pollIntervalMs: 2 });
    let release;
    let entered;
    let context;
    const gate = new Promise((resolve) => { release = resolve; });
    const started = new Promise((resolve) => { entered = resolve; });
    try {
      await pump.ready();
      const descriptor = { name: "typescript.callback", version: "1.0.0", description: "Typed callback observation", input_schema: true, output_schema: true, execution: "queued", permissions: ["typescript.host"], scope: "invocation", max_concurrent: 1, max_call_ms: 10000, max_input_bytes: 1024, max_output_bytes: 1024, effects: "mutating", idempotency: "none" };
      await pump.register([new HostCapability(descriptor, async (_arguments, hostContext) => {
        context = hostContext;
        const unsupported = (error) => error instanceof EmbeddedRuntimeError && error.code === "unsupported";
        assert.throws(() => driver.submit({ type: "describe" }), unsupported);
        assert.throws(() => driver.close(), unsupported);
        await assert.rejects(runtime.operation(hostContext.caller.operation_id).wait(), unsupported);
        entered();
        await gate;
        hostContext.reportEffects("committed");
        return null;
      })]);
      const operation = await consume(runtime.pool(rawPool("return {call=function(a) return vulcan.capabilities.call('typescript.callback',a) end}")).submit("call", null, invocation, 10000));
      await started;
      await assert.rejects(operation.wait({ signal: AbortSignal.timeout(25), pollIntervalMs: 2 }), (error) => error.name === "TimeoutError");
      assert.equal((await consume(operation.status())).cancellation_requested, false);
      assert.equal(context.signal.aborted, false);
      await consume(operation.cancel());
      await poll(() => context.signal.aborted, Boolean);
      release();
      const result = await operation.wait();
      assert.equal(result.phase, "cancelled");
      assert.ok(result.host_effects.some((effect) => effect.effects === "committed"));
    } finally { release(); await pump.close(); }
  });
});

test("failed polling keeps its completed query receipt discoverable on the driver", native, async () => {
  await withClient(async ({ runtime, driver }) => {
    await assert.rejects(runtime.operation("nonexistent-operation").wait(), (error) => error instanceof EmbeddedRuntimeError && error.code === "not_found");
    assert.equal(driver.commands.length, 1);
    assert.equal(driver.commands[0].done, true);
    assert.throws(() => driver.commands[0].deliveredResult(), (error) => error instanceof EmbeddedRuntimeError && error.code === "not_found");
    driver.commands[0].forget();
  });
});

test("typed one-shot initialization reports ready or failed construction and closes each exact slot", native, async () => {
  await withClient(async ({ runtimeConfig }) => {
    const root = mkdtempSync(join(tmpdir(), "luaskills-typed-initialize-"));
    const systemRoot = join(root, "system_lua_lib");
    mkdirSync(systemRoot);
    const transport = new EmbeddedTransport(budgets);
    const driver = new EmbeddedCommandDriver(transport, driverConfig);
    let runtime = null;
    try {
      await driver.ready();
      runtime = await consume(new EmbeddedClient(driver).reserve());
      const engineOptions = createEngineOptions({ runtimeRoot: root, hostOptions: { system_lua_lib_dir: systemRoot, allow_network_download: false, capabilities: { enable_skill_management_bridge: false } } });
      assert.equal(engineOptions.host_options.capabilities.enable_managed_io_compat, true);
      const initialized = await consume(runtime.initialize(engineOptions, runtimeConfig));
      assert.equal(initialized.runtime_id, runtime.runtimeId);
      const status = await consume(runtime.status());
      assert.equal(status.initialization, "ready", JSON.stringify(status));
      const repeated = runtime.initialize(engineOptions, runtimeConfig);
      await assert.rejects(repeated.result(), EmbeddedRuntimeError);
      repeated.forget();
      assert.equal((await consume(runtime.status())).core_runtime_id, status.core_runtime_id);
      await consume(runtime.requestClose());
      await poll(() => consume(runtime.status()), (snapshot) => snapshot.closed);
      await consume(runtime.free());
      runtime = null;
      // Core cache policy is process-wide; a conflicting explicit policy provides real failed-construction evidence.
      // 核心缓存策略属于进程级；冲突的显式策略提供真实构造失败证据。
      runtime = await consume(new EmbeddedClient(driver).reserve());
      const conflictingOptions = { ...engineOptions, host_options: { ...engineOptions.host_options, cache_config: { max_entries: 16, default_ttl_secs: 30, max_ttl_secs: 120 } } };
      assert.equal((await consume(runtime.initialize(conflictingOptions, runtimeConfig))).runtime_id, runtime.runtimeId);
      const failed = await consume(runtime.status());
      assert.equal(failed.initialization, "failed");
      assert.equal(failed.core_runtime_id, null);
      assert.match(failed.error.message, /cache configuration conflicts/);
    } finally {
      if (runtime !== null) {
        await consume(runtime.requestClose());
        await poll(() => consume(runtime.status()), (status) => status.closed);
        await consume(runtime.free());
      }
      await driver.close();
      transport.close();
      transport.free();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
