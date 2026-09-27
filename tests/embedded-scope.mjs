import assert from "node:assert/strict";
import { test } from "node:test";
import { EmbeddedClient, EmbeddedCallbackPump, EmbeddedRuntimeScope, EmbeddedRuntimeError, EmbeddedResultReleaseError, EmbeddedNativeStatus, HostCapability } from "../dist/index.js";
import { EmbeddedScopeExecutor, EmbeddedCallbackExecutor } from "../dist/embedded-driver.js";
import { budgets, withRuntime, poll } from "./embedded-fixture.mjs";

// Native tests require the explicitly selected matching core; fixture and owned runtime remain independent.
// 原生测试要求显式选择匹配核心；夹具运行时与拥有型运行时保持独立。
const native = { skip: !process.env.LUASKILLS_LIB };
const driverConfig = Object.freeze({ workThreads: 1, maxWorkCommands: 2, maxControlCommands: 2 });
const transportConfig = Object.freeze({ ...budgets, max_runtimes: 2 });
const pumpConfig = Object.freeze({ maxConcurrentHandlers: 1, maxPendingCommands: 2, pollIntervalMs: 2 });
const invocation = Object.freeze({ request_context: null, client_budget: null, tool_config: null });

/** Consume one successful fixture receipt; failed evidence remains retained for the test owner.
 * 消费一个成功夹具回执；失败证据仍由测试所有者保留。
 * @param {object} pending Exact typed command receipt.
 * 精确类型化命令回执。
 * @returns {Promise<unknown>} Proven projected delivery.
 * 已证明的投影交付。 */
async function consume(pending) { const result = await pending.result(); pending.forget(); return result; }

/**
 * Provide a second real runtime and explicit adoption without closing the fixture's independent runtime.
 * 提供第二个真实运行时及显式接管，不关闭夹具的独立运行时。
 * @param {Function} action Test body receiving real native handles and adoption helper.
 * 接收真实原生句柄及接管辅助函数的测试主体。
 * @param {object} options Whether to initialize before the test body.
 * 是否在测试主体前初始化。
 * @returns {Promise<void>} Actual scope, driver and transport cleanup.
 * 实际作用域、驱动器及传输清理。
 */
async function withOwnedRuntime(action, { initialize = true } = {}) {
  await withRuntime(async (fixture) => {
    const client = new EmbeddedClient(fixture.driver);
    const runtime = await consume(client.reserve());
    let scope = null;
    try {
      if (initialize) {
        await consume(runtime.initialize(fixture.engineOptions, fixture.runtimeConfig));
        assert.equal((await consume(runtime.status())).initialization, "ready");
        await consume(runtime.registerPlugin(fixture.pluginId, fixture.pluginConfig));
      }
      await action({ ...fixture, client, runtime, adopt: (pump) => { scope = new EmbeddedRuntimeScope(runtime, { pump, pollIntervalMs: 2 }); return scope; } });
    } finally {
      if (scope === null) scope = new EmbeddedRuntimeScope(runtime);
      await scope.close();
      assert.equal(scope.status.phase, "closed");
      assert.equal(EmbeddedRuntimeScope.live.includes(scope), false);
      // The first runtime stays open until its own fixture closes it, proving no root-wide shutdown.
      // 首个运行时保持开放，直到其夹具关闭，证明没有关闭整个根传输。
      assert.equal(fixture.transport.request({ type: "runtime_status", runtime_id: fixture.runtimeId }).closing, false);
    }
  }, { driverConfig, transportConfig });
}

test("scope rejects invalid polling before acquiring any transport or worker ownership", () => {
  for (const value of [0, -1, 0.5, Infinity, 2147483648]) assert.throws(() => new EmbeddedRuntimeScope(null, { pollIntervalMs: value }), RangeError);
  assert.equal(EmbeddedRuntimeScope.live.length, 0);
});

test("scope owns exact reserved runtime, rejects duplicate adoption and independently typed free", native, async () => {
  await withOwnedRuntime(async ({ runtime, adopt, transport }) => {
    const scope = adopt();
    await scope.ready();
    assert.equal(scope.runtime, runtime);
    assert.throws(() => runtime.free(), /lifecycle scope/);
    assert.throws(() => new EmbeddedRuntimeScope(runtime), /already has/);
    assert.throws(() => new EmbeddedCallbackPump(transport, runtime.runtimeId, pumpConfig), /before adopting/);
    await scope[Symbol.asyncDispose]();
    assert.throws(() => transport.request({ type: "runtime_status", runtime_id: runtime.runtimeId }), (error) => error instanceof EmbeddedRuntimeError && error.code === "not_found");
    await scope.close();
  }, { initialize: false });
});

test("scope drains initialized runtime while all ordinary receipt quotas remain full", native, async () => {
  await withOwnedRuntime(async ({ runtime, driver, adopt, transport, moduleDefinition, poolPolicy }) => {
    const pool = await consume(runtime.registerPool(moduleDefinition("return {call=function(a) return a end}"), poolPolicy, [], "scope-v1"));
    await (await consume(pool.submit("call", false, invocation, 10000))).wait();
    const held = [driver.submit({ type: "describe" }, "work"), driver.submit({ type: "describe" }, "work"), driver.submit({ type: "describe" }, "control"), driver.submit({ type: "describe" }, "control")];
    await Promise.all(held.map((receipt) => receipt.result()));
    const scope = adopt();
    try {
      await scope.close();
      assert.equal(scope.status.phase, "closed");
      assert.equal(driver.commands.length, held.length);
      assert.equal(driver.status.closed, false);
      assert.notEqual(transport.transportId, null);
    } finally { for (const receipt of held) receipt.forget(); }
  });
});

test("scope validates exact pump adoption and drains an idle callback worker", native, async () => {
  await withOwnedRuntime(async ({ runtime, client, runtimeId, transport, adopt }) => {
    const pump = new EmbeddedCallbackPump(transport, runtime.runtimeId, pumpConfig);
    try {
      await pump.ready();
      assert.throws(() => new EmbeddedRuntimeScope(runtime), /exact existing callback pump/);
      assert.throws(() => new EmbeddedRuntimeScope(client.runtime(runtimeId), { pump }), /exact live callback pump/);
      const scope = adopt(pump);
      await scope.close();
      assert.equal(pump.status.closed, true);
    } finally { await pump.close(); }
  });
});

test("cancelled close observation preserves actual callback, late effects and owned cleanup", native, async () => {
  await withOwnedRuntime(async ({ runtime, transport, adopt, moduleDefinition, poolPolicy }) => {
    const pump = new EmbeddedCallbackPump(transport, runtime.runtimeId, pumpConfig);
    let release;
    let entered;
    let scope;
    let hostContext;
    let calls = 0;
    const gate = new Promise((resolve) => { release = resolve; });
    const started = new Promise((resolve) => { entered = resolve; });
    try {
      await pump.ready();
      const descriptor = { name: "typescript.scope", version: "1.0.0", description: "Owned callback shutdown integration", input_schema: true, output_schema: true, execution: "queued", permissions: ["typescript.host"], scope: "invocation", max_concurrent: 1, max_call_ms: 10000, max_input_bytes: 1024, max_output_bytes: 1024, effects: "mutating", idempotency: "none" };
      await pump.register([new HostCapability(descriptor, async (_value, context) => {
        calls += 1;
        hostContext = context;
        assert.throws(() => scope.close(), (error) => error instanceof EmbeddedRuntimeError && error.code === "unsupported");
        entered();
        await gate;
        context.reportEffects("committed");
        return null;
      })]);
      scope = adopt(pump);
      const pool = await consume(runtime.registerPool(moduleDefinition("return {call=function(a) return vulcan.capabilities.call('typescript.scope',a) end}"), poolPolicy, ["typescript.host"], "scope-v1"));
      await consume(pool.submit("call", null, invocation, 10000));
      await started;
      await assert.rejects(scope.close({ signal: AbortSignal.timeout(30) }), (error) => error.name === "TimeoutError");
      await poll(() => hostContext.signal.aborted, Boolean);
      assert.equal(scope.status.phase, "draining_callbacks");
      assert.equal(EmbeddedRuntimeScope.live.includes(scope), true);
      assert.equal(pump.status.closed, false);
      release();
      await scope.close();
      assert.equal(calls, 1);
      assert.equal(pump.status.closed, true);
    } finally { release(); await pump.close(); }
  });
});

test("already cancelled observer still starts and retains one owned shutdown attempt", native, async () => {
  await withOwnedRuntime(async ({ adopt }) => {
    const scope = adopt();
    const reason = new Error("scope observer cancelled");
    await assert.rejects(scope.close({ signal: AbortSignal.abort(reason) }), (error) => error === reason);
    await scope.close();
    assert.equal(scope.status.phase, "closed");
  }, { initialize: false });
});

test("copied runtime-free success advances once across release observation failure", native, async () => {
  const original = EmbeddedScopeExecutor.prototype.submit;
  let removals = 0;
  EmbeddedScopeExecutor.prototype.submit = function (command, lane) {
    const receipt = original.call(this, command, lane);
    if (command.type !== "runtime_free") return receipt;
    removals += 1;
    return { get done() { return receipt.done; }, forget: receipt.forget.bind(receipt), deliveredResult: receipt.deliveredResult.bind(receipt), result: async () => { await receipt.result(); throw new EmbeddedResultReleaseError(EmbeddedNativeStatus.BUSY, Buffer.from(receipt.responseBytes)); } };
  };
  try {
    await withOwnedRuntime(async ({ adopt }) => {
      const scope = adopt();
      await assert.rejects(scope.close(), EmbeddedResultReleaseError);
      assert.equal(scope.status.phase, "released");
      assert.equal(scope.status.needsResultRelease, true);
      assert.equal(EmbeddedRuntimeScope.live.includes(scope), true);
      await assert.rejects(scope.close(), EmbeddedResultReleaseError);
      assert.equal(removals, 1);
      await scope.retryClose();
      assert.equal(removals, 1);
      assert.equal(scope.status.phase, "closed");
    });
  } finally { EmbeddedScopeExecutor.prototype.submit = original; }
});

test("lost close observation recovers its original receipt without replaying runtime-close", native, async () => {
  const original = EmbeddedScopeExecutor.prototype.submit;
  let closures = 0;
  EmbeddedScopeExecutor.prototype.submit = function (command, lane) {
    const receipt = original.call(this, command, lane);
    if (command.type !== "runtime_close") return receipt;
    closures += 1;
    return { get done() { return receipt.done; }, forget: receipt.forget.bind(receipt), deliveredResult: receipt.deliveredResult.bind(receipt), result: async () => { await receipt.result(); throw new Error("Injected lost scope receipt observation"); } };
  };
  try {
    await withOwnedRuntime(async ({ adopt }) => {
      const scope = adopt();
      await assert.rejects(scope.close(), /Injected lost/);
      assert.equal(scope.status.pendingCommand, "runtime_close");
      await assert.rejects(scope.close(), /Injected lost/);
      assert.equal(closures, 1);
      await scope.retryClose();
      assert.equal(closures, 1);
    });
  } finally { EmbeddedScopeExecutor.prototype.submit = original; }
});

test("scope releases failed initialization slots after reading actual failed status", native, async () => {
  await withOwnedRuntime(async ({ runtime, adopt, engineOptions, runtimeConfig }) => {
    await consume(runtime.initialize({ ...engineOptions, host_options: { ...engineOptions.host_options, cache_config: { default_ttl_secs: 1, max_entries: 1, max_ttl_secs: 1 } } }, runtimeConfig));
    assert.equal((await consume(runtime.status())).initialization, "failed");
    await adopt().close();
  }, { initialize: false });
});

test("unused worker startup failure returns the claim only after actual worker exit", native, async () => {
  const original = EmbeddedScopeExecutor.prototype.ready;
  EmbeddedScopeExecutor.prototype.ready = async function () { await original.call(this); throw new Error("Injected unused scope startup failure"); };
  try {
    await withOwnedRuntime(async ({ runtime, adopt }) => {
      const failed = new EmbeddedRuntimeScope(runtime);
      await assert.rejects(failed.ready(), /Injected unused/);
      assert.equal(failed.status.phase, "startup_failed");
      assert.equal(EmbeddedRuntimeScope.live.includes(failed), false);
      assert.equal((await consume(runtime.status())).closing, false);
      EmbeddedScopeExecutor.prototype.ready = original;
      await adopt().close();
    });
  } finally { EmbeddedScopeExecutor.prototype.ready = original; }
});

test("scope rejects aggregate response-frame overcommit without stealing ownership", native, async () => {
  await withRuntime(async ({ driver, runtimeId, transport }) => {
    const runtime = new EmbeddedClient(driver).runtime(runtimeId);
    assert.throws(() => new EmbeddedRuntimeScope(runtime), /concurrent response frames/);
    assert.equal(EmbeddedRuntimeScope.live.length, 0);
    assert.equal(transport.request({ type: "runtime_status", runtime_id: runtimeId }).closing, false);
  }, { driverConfig, transportConfig: { ...budgets, max_result_buffers: 2 } });
});

test("missing copied free evidence retains ownership and never retries slot removal", native, async () => {
  const original = EmbeddedScopeExecutor.prototype.submit;
  let removals = 0;
  let recoverable = false;
  EmbeddedScopeExecutor.prototype.submit = function (command, lane) {
    const receipt = original.call(this, command, lane);
    if (command.type !== "runtime_free") return receipt;
    removals += 1;
    return { get done() { return receipt.done; }, forget: receipt.forget.bind(receipt), deliveredResult: () => { if (!recoverable) throw new Error("Copied free evidence unavailable"); return receipt.deliveredResult(); }, result: async () => { await receipt.result(); throw new Error("Lost free delivery observation"); } };
  };
  try {
    await withOwnedRuntime(async ({ adopt, runtime }) => {
      const scope = adopt();
      await assert.rejects(scope.close(), /Lost free/);
      await assert.rejects(scope.retryClose(), /evidence unavailable/);
      assert.equal(scope.status.phase, "releasing_runtime");
      assert.equal(EmbeddedRuntimeScope.live.includes(scope), true);
      assert.throws(() => runtime.free(), /lifecycle scope/);
      assert.equal(removals, 1);
      recoverable = true;
      await scope.retryClose();
      assert.equal(removals, 1);
    });
  } finally { EmbeddedScopeExecutor.prototype.submit = original; }
});

test("scope reports callback recovery demand and resumes exact registration evidence", native, async () => {
  const original = EmbeddedCallbackExecutor.prototype.submit;
  let unregisters = 0;
  EmbeddedCallbackExecutor.prototype.submit = function (command, lane) {
    const receipt = original.call(this, command, lane);
    if (command.type !== "runtime" || command.operation.type !== "capability_unregister") return receipt;
    unregisters += 1;
    return { get done() { return receipt.done; }, forget: receipt.forget.bind(receipt), deliveredResult: receipt.deliveredResult.bind(receipt), result: async () => { await receipt.result(); throw new Error("Injected lost unregister observation"); } };
  };
  try {
    await withOwnedRuntime(async ({ runtime, transport, adopt }) => {
      const pump = new EmbeddedCallbackPump(transport, runtime.runtimeId, pumpConfig);
      try {
        await pump.ready();
        await pump.register([new HostCapability({ name: "typescript.scope.recover", version: "1.0.0", description: "Scope registration recovery", input_schema: true, output_schema: true, execution: "queued", permissions: [], scope: "invocation", max_concurrent: 1, max_call_ms: 10000, max_input_bytes: 1024, max_output_bytes: 1024, effects: "read_only", idempotency: "none" }, () => null)]);
        const scope = adopt(pump);
        await assert.rejects(scope.close(), /explicit delivery recovery/);
        assert.equal(scope.status.phase, "draining_callbacks");
        assert.equal(scope.status.retryable, true);
        assert.equal(pump.recoveryRequired, true);
        await scope.retryClose();
        assert.equal(unregisters, 1);
        assert.equal(pump.status.closed, true);
      } finally { await pump.close(); }
    });
  } finally { EmbeddedCallbackExecutor.prototype.submit = original; }
});

test("scope checkpoints require exact identities and typed status evidence, including copied release failures", native, async () => {
  // Each mutation runs against the real core once; only SDK delivery is deliberately corrupted.
  // 每个变更仅在真实核心执行一次；只故意破坏 SDK 交付。
  const cases = [
    { type: "runtime_close", phase: "closing_runtime", corrupt: (value) => ({ ...value, runtime_id: "another-slot" }) },
    { type: "runtime_close", phase: "closing_runtime", corrupt: () => ({}) },
    { type: "runtime_status", phase: "draining_runtime", corrupt: (value) => ({ ...value, runtime_id: "another-slot" }) },
    { type: "runtime_status", phase: "draining_runtime", corrupt: (value) => ({ ...value, closed: "true" }) },
    { type: "runtime_status", phase: "draining_runtime", corrupt: (value) => ({ ...value, initialization: "unknown" }) },
    { type: "runtime_status", phase: "draining_runtime", corrupt: (value) => ({ ...value, initialization: null }) },
    { type: "runtime_free", phase: "releasing_runtime", corrupt: (value) => ({ ...value, runtime_id: "another-slot" }) },
    { type: "runtime_free", phase: "releasing_runtime", corrupt: () => null },
    { type: "runtime_free", phase: "releasing_runtime", release: true, corrupt: (value) => ({ ...value, runtime_id: "another-slot" }) },
  ];
  for (const scenario of cases) {
    const original = EmbeddedScopeExecutor.prototype.submit;
    let deliveries = 0;
    let recoverable = false;
    EmbeddedScopeExecutor.prototype.submit = function (command, lane) {
      const receipt = original.call(this, command, lane);
      if (command.type !== scenario.type) return receipt;
      deliveries += 1;
      return {
        get done() { return receipt.done; }, forget: receipt.forget.bind(receipt),
        deliveredResult: () => recoverable ? receipt.deliveredResult() : scenario.corrupt(receipt.deliveredResult()),
        result: async () => {
          const value = await receipt.result();
          if (scenario.release) throw new EmbeddedResultReleaseError(EmbeddedNativeStatus.INTERNAL, null);
          return recoverable ? value : scenario.corrupt(value);
        },
      };
    };
    try {
      await withOwnedRuntime(async ({ adopt, runtime }) => {
        const scope = adopt();
        try {
          await assert.rejects(scope.close(), /slot identity|lifecycle evidence|result_free/);
          assert.equal(scope.status.phase, scenario.phase);
          assert.equal(EmbeddedRuntimeScope.live.includes(scope), true);
          assert.throws(() => runtime.free(), /lifecycle scope/);
          await assert.rejects(scope.retryClose(), /slot identity|lifecycle evidence/);
          assert.equal(deliveries, 1, "invalid delivery must not authorize native replay");
        } finally {
          // Restore the original retained receipt, not a second native operation, to complete real cleanup.
          // 恢复原保留回执而非第二次原生操作，以完成实际清理。
          recoverable = true;
          await scope.retryClose();
        }
        assert.equal(deliveries, 1);
      }, { initialize: false });
    } finally { EmbeddedScopeExecutor.prototype.submit = original; }
  }
});
