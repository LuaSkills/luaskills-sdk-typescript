import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { EmbeddedCallbackPump, HostCapability, EmbeddedCommandDriver, EmbeddedTransport, EmbeddedRuntimeError, EmbeddedResultReleaseError, EmbeddedNativeStatus, EmbeddedFloat } from "../dist/index.js";
import { EmbeddedCallbackExecutor } from "../dist/embedded-driver.js";
import { budgets, withRuntime, poll } from "./embedded-fixture.mjs";

// Real integration requires the matching explicitly selected development DLL.
// 真实集成要求显式选定匹配的开发 DLL。
const native = { skip: !process.env.LUASKILLS_LIB };
const limits = Object.freeze({ maxConcurrentHandlers: 2, maxPendingCommands: 2, pollIntervalMs: 2 });

// Native completion accepts ownership while projecting an invalid application result as a committed error.
// 原生完成接纳所有权，同时把无效应用结果投影为已提交错误。
test("unsafe integer callback completion preserves the exact committed ledger and remains reusable", native, async () => {
  await withPump(async ({ pump, command, pool, submit, terminal }) => {
    // Track exact callback identities so completion assertions cannot bind to a changing array index.
    // 跟踪精确回调身份，避免完成断言依赖变化的数组下标。
    const requests = [];
    await pump.register([capability("typescript.callback", (value, context) => {
      requests.push(context.requestId);
      context.reportEffects("committed");
      return value === "unsafe" ? 18446744073709551615n : value;
    })]);
    const poolId = pool("return {call=function(a) return vulcan.capabilities.call('typescript.callback',a) end}");
    const rejected = await terminal(submit(poolId, "unsafe"));
    assert.equal(rejected.phase, "succeeded");
    // Overall Lua execution remains unknown; one host commit cannot establish the entire operation's effects.
    // 整体 Lua 执行保持未知；一次宿主提交不能确定整个操作的副作用。
    assert.equal(rejected.effects, "unknown");
    assert.equal(rejected.value.ok, false);
    assert.equal(rejected.value.error.code, "invalid_argument");
    assert.equal(rejected.value.effects, "committed");
    const effect = rejected.host_effects.find((entry) => entry.request_id === requests[0]);
    assert.ok(effect, "Original callback ledger identity is missing");
    assert.equal(effect.phase, "completed");
    assert.equal(effect.effects, "committed");
    assert.equal((await terminal(submit(poolId, "normal"))).value.value, "normal");
    await pump.close();
    assert.equal(requests.length, 2);
    assert.equal(pump.status.failure, null);
    assert.deepEqual(pump.status.requestIds, []);
    assert.deepEqual(pump.status.pendingAcknowledgements, []);
  });
});

/**
 * Create one actual queued declaration using the existing fixture's trusted permission.
 * 使用现有夹具的可信权限创建一个实际队列声明。
 * @param {string} name Exact namespaced capability name.
 * 精确命名空间能力名称。
 * @param {Function} handler Host implementation retained by the pump.
 * 泵保留的宿主实现。
 * @returns {HostCapability} Explicit mutating queued capability.
 * 显式变更类队列能力。
 */
function capability(name, handler) {
  return new HostCapability({ name, version: "1.0.0", description: "TypeScript automatic callback integration", input_schema: true, output_schema: true, execution: "queued", permissions: ["typescript.host"], scope: "invocation", max_concurrent: 2, max_call_ms: 10000, max_input_bytes: 1024, max_output_bytes: 1024, effects: "mutating", idempotency: "none" }, handler);
}

/**
 * Own an automatic pump inside the existing real runtime fixture through actual native drainage.
 * 在现有真实运行时夹具中拥有自动泵直到实际原生排空。
 * @param {Function} action Test body receiving the initialized fixture and pump.
 * 接收已初始化夹具及泵的测试主体。
 * @param {object} options Optional explicit ordinary-driver fixture configuration.
 * 可选显式普通驱动夹具配置。
 * @returns {Promise<void>} Actual pump, runtime and transport cleanup completion.
 * 实际泵、运行时及传输清理完成。
 */
async function withPump(action, { pumpConfig = limits, ...runtimeOptions } = {}) {
  await withRuntime(async (fixture) => {
    const pump = new EmbeddedCallbackPump(fixture.transport, fixture.runtimeId, pumpConfig);
    try { await pump.ready(); await action({ ...fixture, pump }); }
    finally { await pump.close(); }
  }, runtimeOptions);
}

test("pump configuration rejects executable and out-of-range timer limits before claiming a transport", () => {
  let touched = 0;
  const transport = { claimCallbackPump() { touched += 1; throw new Error("Unexpected native ownership"); } };
  const getter = { ...limits, get pollIntervalMs() { touched += 1; return 1; } };
  for (const config of [getter, new Proxy(limits, {}), { ...limits, extra: 1 }]) assert.throws(() => new EmbeddedCallbackPump(transport, "unused", config), /three data limits/);
  assert.throws(() => new EmbeddedCallbackPump(transport, "unused", { ...limits, pollIntervalMs: 2147483648 }), /timer range/);
  assert.equal(touched, 0);
});

test("automatic callbacks preserve exact authority, explicit effects, nulls and floating-point intent", native, async () => {
  await withPump(async ({ pump, pool, submit, terminal, pluginId }) => {
    let retainedContext;
    const identities = await pump.register([capability("typescript.callback", async (argumentsValue, context) => {
      retainedContext = context;
      assert.equal(context.caller.plugin_id, pluginId);
      assert.ok(Object.isFrozen(context.caller));
      assert.equal(typeof context.remainingMs, "bigint");
      await delay(1);
      context.reportEffects("committed");
      return { arg: argumentsValue, float: new EmbeddedFloat(1e100), empty: null };
    })]);
    assert.ok(Object.isFrozen(identities));
    const operationId = submit(pool("return {call=function(a) return vulcan.capabilities.call('typescript.callback',a) end}"), { plugin_id: "forged" });
    const done = await terminal(operationId);
    assert.equal(done.phase, "succeeded", JSON.stringify(done, (_key, value) => typeof value === "bigint" ? String(value) : value));
    assert.equal(done.value.ok, true);
    assert.equal(done.value.value.arg.plugin_id, "forged");
    assert.equal(done.value.value.float.value, 1e100);
    assert.equal(done.value.value.empty, null);
    // Compare every historical authority field with the actual callback, excluding the forged business argument.
    // 对照真实回调比较每个历史权威字段，排除伪造业务参数。
    assert.deepEqual(done.host_effects.find((effect) => effect.request_id === retainedContext.requestId).caller, retainedContext.caller);
    assert.ok(done.host_effects.some((effect) => effect.effects === "committed"));
    assert.throws(() => retainedContext.reportEffects("rolled_back"), /sealed/);
    await pump.unregister(identities[0]);
    assert.equal(pump.status.registrationIds.length, 0);
  });
});

test("synchronous handler exceptions retain committed effects without exposing exception secrets", native, async () => {
  await withPump(async ({ pump, pool, submit, terminal }) => {
    await pump.register([capability("typescript.callback", (_arguments, context) => { context.reportEffects("committed"); throw new Error("private-token-must-not-leak"); })]);
    const done = await terminal(submit(pool("return {call=function(a) return vulcan.capabilities.call('typescript.callback',a) end}"), null));
    assert.equal(done.phase, "succeeded");
    assert.equal(done.value.ok, false);
    assert.equal(done.value.error.code, "execution_failed");
    assert.ok(!JSON.stringify(done).includes("private-token-must-not-leak"));
    assert.ok(done.host_effects.some((effect) => effect.effects === "committed"));
  });
});

test("declared SDK callback errors preserve their stable protocol code", native, async () => {
  await withPump(async ({ pump, pool, submit, terminal }) => {
    await pump.register([capability("typescript.callback", (_arguments, context) => {
      context.reportEffects("not_started");
      throw new EmbeddedRuntimeError("permission_denied", "Host policy rejected this action");
    })]);
    const done = await terminal(submit(pool("return {call=function(a) return vulcan.capabilities.call('typescript.callback',a) end}"), null));
    assert.equal(done.value.ok, false);
    assert.equal(done.value.error.code, "permission_denied");
    assert.equal(done.value.effects, "not_started");
  });
});

test("callback cancellation and close observers preserve the real handler and its late committed acknowledgement", native, async () => {
  await withPump(async ({ transport, driver, pump, pool, submit, terminal, command }) => {
    let release;
    const returned = new Promise((resolve) => { release = resolve; });
    let context;
    await pump.register([capability("typescript.callback", async (_arguments, current) => {
      context = current;
      await returned;
      current.reportEffects("committed");
      return null;
    })]);
    const work = [driver.submit({ type: "describe" }), driver.submit({ type: "describe" })];
    const control = [driver.submit({ type: "describe" }, "control"), driver.submit({ type: "describe" }, "control")];
    const operationId = submit(pool("return {call=function(a) return vulcan.capabilities.call('typescript.callback',a) end}"), null);
    try {
      await poll(() => context, (value) => value !== undefined);
      command({ type: "operation_cancel", operation_id: operationId });
      const reason = new Error("close observer cancelled");
      const signal = AbortSignal.abort(reason);
      await assert.rejects(pump.close({ signal }), (error) => error === reason);
      await poll(() => context.signal.aborted, Boolean);
      assert.equal(pump.status.closed, false);
      assert.equal(pump.status.requestIds.length, 1);
      assert.throws(() => transport.free(), /callback pump|command driver/);
    } finally { release(); }
    const done = await terminal(operationId);
    assert.ok(["cancelled", "failed"].includes(done.phase));
    assert.ok(done.host_effects.some((effect) => effect.effects === "committed"));
    await pump.close();
    await Promise.all([...work, ...control].map((receipt) => receipt.result()));
  }, { driverConfig: { workThreads: 1, maxWorkCommands: 2, maxControlCommands: 2 } });
});

test("cancelled registration observation retains the published handlers and discoverable identities", native, async () => {
  await withPump(async ({ pump, pool, submit, terminal }) => {
    let calls = 0;
    const reason = new Error("registration observer cancelled");
    await assert.rejects(pump.register([capability("typescript.callback", () => { calls += 1; return null; })], { signal: AbortSignal.abort(reason) }), (error) => error === reason);
    await poll(() => pump.status.registrationIds, (ids) => ids.length === 1);
    const done = await terminal(submit(pool("return {call=function(a) return vulcan.capabilities.call('typescript.callback',a) end}"), null));
    assert.equal(done.phase, "succeeded");
    assert.equal(calls, 1);
    assert.ok(done.host_effects.some((effect) => effect.effects === "unknown"));
  });
});

test("one pump per runtime and aggregate driver frames are checked before worker creation", native, async () => {
  await withPump(async ({ transport, runtimeId, pump }) => {
    assert.throws(() => new EmbeddedCallbackPump(transport, runtimeId, limits), /already has a callback pump/);
    assert.ok(EmbeddedCallbackPump.live.includes(pump));
  });
  const transport = new EmbeddedTransport({ ...budgets, max_result_buffers: 2 });
  const driver = new EmbeddedCommandDriver(transport, { workThreads: 1, maxWorkCommands: 1, maxControlCommands: 1 });
  try {
    await driver.ready();
    assert.throws(() => new EmbeddedCallbackPump(transport, "unused", limits), /concurrent response frames/);
  } finally { await driver.close(); transport.close(); transport.free(); }
});

test("a pump rejects an uninitialized runtime and returns its ownership after actual worker exit", native, async () => {
  const transport = new EmbeddedTransport(budgets);
  const runtimeId = transport.request({ type: "runtime_reserve" }).runtime_id;
  const pump = new EmbeddedCallbackPump(transport, runtimeId, limits);
  try {
    await assert.rejects(pump.ready(), /initialized open runtime/);
    await pump.close();
    assert.equal(pump.status.closed, true);
    assert.ok(!EmbeddedCallbackPump.live.includes(pump));
  } finally {
    await pump.close(); transport.close();
    transport.request({ type: "runtime_free", runtime_id: runtimeId }); transport.free();
  }
});

test("bounded handler capacity retains a queued callback until the first actual handler finishes", native, async () => {
  await withPump(async ({ pump, pool, submit, terminal }) => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let calls = 0;
    let active = 0;
    let peak = 0;
    await pump.register([capability("typescript.callback", async () => {
      calls += 1; active += 1; peak = Math.max(peak, active);
      try { await gate; return null; } finally { active -= 1; }
    })]);
    const poolId = pool("return {call=function(a) return vulcan.capabilities.call('typescript.callback',a) end}");
    const first = submit(poolId, null);
    const second = submit(poolId, null);
    try {
      await poll(() => calls, (count) => count === 1);
      await delay(15);
      assert.equal(calls, 1);
      assert.equal(pump.status.requestIds.length, 1);
    } finally { release(); }
    assert.equal((await terminal(first)).phase, "succeeded");
    assert.equal((await terminal(second)).phase, "succeeded");
    assert.equal(calls, 2);
    assert.equal(peak, 1);
  }, { pumpConfig: { ...limits, maxConcurrentHandlers: 1 } });
});

test("registration admission freezes descriptors and rejects accessor batches without invoking them", native, async () => {
  await withPump(async ({ pump, pool, submit, terminal }) => {
    const handler = () => "original-handler";
    const descriptor = { ...capability("typescript.callback", handler).snapshot(65536n).descriptor };
    const owned = new HostCapability(descriptor, handler);
    let invoked = 0;
    const getter = [owned];
    Object.defineProperty(getter, "0", { get() { invoked += 1; return owned; } });
    await assert.rejects(pump.register(getter), /dense array data/);
    const proxy = new Proxy(owned, { getPrototypeOf() { invoked += 1; return HostCapability.prototype; } });
    await assert.rejects(pump.register([proxy]), /HostCapability instances/);
    assert.equal(invoked, 0);
    const publication = pump.register([owned]);
    descriptor.name = "mutated-after-registration";
    descriptor.effects = "read_only";
    await publication;
    const done = await terminal(submit(pool("return {call=function(a) return vulcan.capabilities.call('typescript.callback',a) end}"), null));
    assert.equal(done.value.ok, true);
    assert.equal(done.value.value, "original-handler");
    assert.equal(done.value.effects, "unknown");
  });
});

test("publication admission is bounded while accepted batches remain observable after cancellation", native, async () => {
  await withPump(async ({ pump }) => {
    const first = pump.register([capability("typescript.first", () => null)]);
    const second = pump.register([capability("typescript.second", () => null)]);
    await assert.rejects(pump.register([capability("typescript.third", () => null)]), (error) => error instanceof EmbeddedRuntimeError && error.code === "capacity_exceeded");
    assert.equal(pump.status.pendingCommands, limits.maxPendingCommands);
    await Promise.all([first, second]);
    assert.equal(pump.status.pendingCommands, 0);
    assert.equal(pump.status.registrationIds.length, 2);
  });
});

test("invalid handler output preserves effects and returns a bounded explicit failure", native, async () => {
  await withPump(async ({ pump, pool, submit, terminal }) => {
    await pump.register([capability("typescript.callback", (_arguments, context) => {
      context.reportEffects("committed");
      return { invalid: undefined };
    })]);
    const done = await terminal(submit(pool("return {call=function(a) return vulcan.capabilities.call('typescript.callback',a) end}"), null));
    assert.equal(done.value.ok, false);
    assert.equal(done.value.error.code, "execution_failed");
    assert.equal(done.value.effects, "committed");
    assert.ok(done.host_effects.some((effect) => effect.effects === "committed"));
  });
});

test("externally registered requests are rejected as not started instead of being routed by name", native, async () => {
  await withPump(async ({ pump, command, pool, submit, terminal }) => {
    command({ type: "capabilities_register", descriptors: [capability("typescript.callback", () => { throw new Error("must never run"); }).snapshot(65536n).descriptor] });
    const done = await terminal(submit(pool("return {call=function(a) return vulcan.capabilities.call('typescript.callback',a) end}"), null));
    assert.equal(done.value.ok, false);
    assert.equal(done.value.error.code, "internal");
    assert.equal(done.value.effects, "not_started");
    await pump.close();
    assert.match(pump.status.failure, /no exact JavaScript registration owner/);
  });
});

test("closing before readiness settles startup observers and joins the callback worker", native, async () => {
  await withRuntime(async ({ transport, runtimeId }) => {
    const pump = new EmbeddedCallbackPump(transport, runtimeId, limits);
    const readiness = assert.rejects(pump.ready(), /closed before becoming ready/);
    await pump.close();
    await readiness;
    assert.equal(pump.status.closed, true);
  });
});

test("same-name replacement never redirects an existing pool to a different handler generation", native, async () => {
  await withPump(async ({ pump, pool, submit, terminal }) => {
    let oldCalls = 0;
    let newCalls = 0;
    const [oldId] = await pump.register([capability("typescript.callback", () => { oldCalls += 1; return "old"; })]);
    const source = "return {call=function(a) return vulcan.capabilities.call('typescript.callback',a) end}";
    const oldPool = pool(source);
    assert.equal((await terminal(submit(oldPool, null))).value.value, "old");
    await pump.unregister(oldId);
    const [newId] = await pump.register([capability("typescript.callback", () => { newCalls += 1; return "new"; })]);
    assert.notEqual(oldId, newId);
    assert.equal((await terminal(submit(oldPool, null))).value.error.code, "closed");
    const newPool = pool(source);
    assert.equal((await terminal(submit(newPool, null))).value.value, "new");
    assert.equal(oldCalls, 1);
    assert.equal(newCalls, 1);
  });
});

test("separate native runtimes keep same-name JavaScript handlers isolated through one pump closing", native, async () => {
  await withPump(async (left) => {
    await left.pump.register([capability("typescript.callback", () => "left")]);
    const source = "return {call=function(a) return vulcan.capabilities.call('typescript.callback',a) end}";
    const leftPool = left.pool(source);
    await withPump(async (right) => {
      assert.notEqual(left.runtimeId, right.runtimeId);
      await right.pump.register([capability("typescript.callback", () => "right")]);
      const rightPool = right.pool(source);
      assert.equal((await left.terminal(left.submit(leftPool, null))).value.value, "left");
      assert.equal((await right.terminal(right.submit(rightPool, null))).value.value, "right");
    });
    assert.equal((await left.terminal(left.submit(leftPool, null))).value.value, "left");
  });
});

test("native registration rejection and callback self-drain leave no hidden command ownership", native, async () => {
  await withPump(async ({ pump, pool, submit, terminal }) => {
    const invalid = capability("", () => null);
    await assert.rejects(pump.register([invalid]), EmbeddedRuntimeError);
    assert.equal(pump.status.pendingCommands, 0);
    await pump.register([capability("typescript.callback", async () => {
      assert.throws(() => pump.close(), (error) => error instanceof EmbeddedRuntimeError && error.code === "unsupported");
      return null;
    })]);
    const done = await terminal(submit(pool("return {call=function(a) return vulcan.capabilities.call('typescript.callback',a) end}"), null));
    assert.equal(done.phase, "succeeded");
  });
});

/**
 * Lose exactly one observed result after the actual native command has completed successfully.
 * 在实际原生命令成功完成后，丢失恰好一次观察结果。
 * @param {string} type Exact runtime command to intercept.
 * 精确要拦截的运行时命令。
 * @param {Function} action Test body running while the boundary fault is installed.
 * 安装边界故障期间运行的测试主体。
 * @returns {Promise<void>} Completion after restoring the original executor method.
 * 恢复原始执行器方法之后完成。
 */
async function withLostReply(type, action) {
  const original = EmbeddedCallbackExecutor.prototype.submit;
  let injected = false;
  let attempts = 0;
  EmbeddedCallbackExecutor.prototype.submit = function (command, lane) {
    const receipt = original.call(this, command, lane);
    if (command.type !== "runtime" || command.operation.type !== type) return receipt;
    attempts += 1;
    if (injected) return receipt;
    injected = true;
    return { get done() { return receipt.done; }, forget: receipt.forget.bind(receipt), deliveredResult: receipt.deliveredResult.bind(receipt), result: async () => { await receipt.result(); throw new Error("Injected lost callback control reply"); } };
  };
  try { await action(() => attempts); }
  finally { EmbeddedCallbackExecutor.prototype.submit = original; }
}

test("lost completion replies reconcile exact core effects without replaying handlers or acknowledgements", native, async () => {
  await withLostReply("host_request_complete", async (attempts) => {
    await withPump(async ({ pump, pool, submit, terminal }) => {
      let calls = 0;
      await pump.register([capability("typescript.callback", (_arguments, context) => { calls += 1; context.reportEffects("committed"); return null; })]);
      const done = await terminal(submit(pool("return {call=function(a) return vulcan.capabilities.call('typescript.callback',a) end}"), null));
      assert.equal(done.phase, "succeeded");
      await poll(() => pump.status, (status) => status.failure !== null);
      assert.equal(pump.status.pendingAcknowledgements.length, 1);
      await pump.retryAcknowledgements();
      await pump.close();
      assert.equal(calls, 1);
      assert.equal(attempts(), 1);
    });
  });
});

for (const mutation of ["capabilities_register", "capability_unregister", "capability_forget"]) {
  test(`lost ${mutation} reply recovers the original mutation receipt without native replay`, native, async () => {
    await withLostReply(mutation, async (attempts) => {
      await withPump(async ({ pump }) => {
        const publication = pump.register([capability("typescript.callback", () => null)]);
        if (mutation === "capabilities_register") await assert.rejects(publication, /Injected lost/);
        else { await publication; void pump.close(); }
        await poll(() => pump.status, (status) => status.failure !== null);
        await pump.retryAcknowledgements();
        await pump.close();
        assert.equal(attempts(), 1);
      });
    });
  });
}

test("lost nonempty request extraction recovers its original receipt and executes each handler once", native, async () => {
  const original = EmbeddedCallbackExecutor.prototype.submit;
  let lostRequests = null;
  let calls = 0;
  EmbeddedCallbackExecutor.prototype.submit = function (command, lane) {
    const receipt = original.call(this, command, lane);
    if (command.type !== "runtime" || command.operation.type !== "host_requests_take") return receipt;
    return { get done() { return receipt.done; }, forget: receipt.forget.bind(receipt), deliveredResult: receipt.deliveredResult.bind(receipt), result: async () => {
      const requests = await receipt.result();
      if (lostRequests === null && requests.length !== 0) { lostRequests = requests; throw new Error("Injected lost nonempty extraction reply"); }
      return requests;
    } };
  };
  try {
    await withPump(async ({ pump, pool, submit, terminal, command }) => {
      await pump.register([capability("typescript.callback", (_arguments, context) => { calls += 1; context.reportEffects("committed"); return "recovered"; })]);
      const operationId = submit(pool("return {call=function(a) return vulcan.capabilities.call('typescript.callback',a) end}"), null);
      try {
        await poll(() => pump.status, (status) => status.failure !== null);
        assert.equal(pump.status.pendingExtraction, true);
        await pump.retryAcknowledgements();
        await poll(() => calls, (count) => count !== 0);
        assert.equal(pump.status.pendingExtraction, false);
        const done = await terminal(operationId);
        assert.equal(done.value.value, "recovered");
        assert.equal(calls, 1);
        assert.ok(done.host_effects.some((effect) => effect.effects === "committed"));
      } finally {
        // A failing regression still acknowledges its known delivered request so the real core can drain.
        // 回归失败时仍确认已知已交付请求，使真实核心能够排空。
        if (calls === 0 && lostRequests !== null) for (const request of lostRequests) command({ type: "host_request_complete", request_id: request.request_id, outcome: { ok: false, error: { code: "execution_failed", message: "Test cleanup after missing recovery" }, effects: "not_started" } });
      }
    });
  } finally { EmbeddedCallbackExecutor.prototype.submit = original; }
});

test("fatal publication delivery rejects pump close without falsely releasing its worker claim", native, () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./fixtures/embedded-pump-fault.mjs", import.meta.url))], { encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
});

test("missing exact completion evidence retains the acknowledgement until a later proven retry", native, async () => {
  await withLostReply("host_request_complete", async (attempts) => {
    await withPump(async ({ pump, pool, submit, terminal }) => {
      let calls = 0;
      await pump.register([capability("typescript.callback", (_arguments, context) => { calls += 1; context.reportEffects("committed"); return null; })]);
      await terminal(submit(pool("return {call=function(a) return vulcan.capabilities.call('typescript.callback',a) end}"), null));
      await poll(() => pump.status, (status) => status.failure !== null);
      const original = EmbeddedCallbackExecutor.prototype.submit;
      EmbeddedCallbackExecutor.prototype.submit = function (command, lane) {
        const receipt = original.call(this, command, lane);
        if (command.type !== "runtime" || command.operation.type !== "operation_status") return receipt;
        return { get done() { return receipt.done; }, forget: receipt.forget.bind(receipt), deliveredResult: receipt.deliveredResult.bind(receipt), result: async () => ({ ...await receipt.result(), host_effects: [] }) };
      };
      try {
        await assert.rejects(pump.retryAcknowledgements(), (error) => error instanceof EmbeddedRuntimeError && error.code === "not_found");
        assert.equal(pump.status.pendingAcknowledgements.length, 1);
        assert.equal(pump.status.closed, false);
        assert.equal(calls, 1);
        assert.equal(attempts(), 1);
      } finally {
        EmbeddedCallbackExecutor.prototype.submit = original;
        await pump.retryAcknowledgements();
      }
    });
  });
});

test("copied completion survives a simulated release observation failure without mutation replay", native, async () => {
  const original = EmbeddedCallbackExecutor.prototype.submit;
  let attempts = 0;
  let calls = 0;
  EmbeddedCallbackExecutor.prototype.submit = function (command, lane) {
    const receipt = original.call(this, command, lane);
    if (command.type !== "runtime" || command.operation.type !== "host_request_complete") return receipt;
    attempts += 1;
    return { get done() { return receipt.done; }, forget: receipt.forget.bind(receipt), deliveredResult: receipt.deliveredResult.bind(receipt), result: async () => {
      await receipt.result();
      // This injects only the copied-result observation; worker protocol tests cover actual retained allocations.
      // 此处仅注入复制结果观察故障；工作线程协议测试覆盖实际保留的分配。
      throw new EmbeddedResultReleaseError(EmbeddedNativeStatus.BUSY, Buffer.from(receipt.responseBytes));
    } };
  };
  try {
    await withPump(async ({ pump, pool, submit, terminal, transport }) => {
      await pump.register([capability("typescript.callback", (_arguments, context) => { calls += 1; context.reportEffects("committed"); return null; })]);
      const done = await terminal(submit(pool("return {call=function(a) return vulcan.capabilities.call('typescript.callback',a) end}"), null));
      await poll(() => pump.status, (status) => status.needsResultRelease);
      try {
        assert.equal(pump.status.closed, false);
        assert.equal(pump.status.pendingAcknowledgements.length, 0);
        assert.throws(() => transport.free(), /callback pump/);
        assert.ok(done.host_effects.some((effect) => effect.effects === "committed"));
      } finally { await pump.retryAcknowledgements(); }
      await pump.close();
      assert.equal(pump.status.needsResultRelease, false);
      assert.equal(calls, 1);
      assert.equal(attempts, 1);
    });
  } finally { EmbeddedCallbackExecutor.prototype.submit = original; }
});
