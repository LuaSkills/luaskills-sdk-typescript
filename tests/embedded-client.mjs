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
