import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createHook } from "node:async_hooks";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { EmbeddedTransport, EmbeddedCommandDriver, EmbeddedFloat, EmbeddedRuntimeError, EmbeddedTransportError, EmbeddedNativeStatus } from "../dist/index.js";
import { budgets, withRuntime, poll } from "./embedded-fixture.mjs";

// Native integration requires an explicitly selected matching development library.
// 原生集成要求显式选择匹配的开发动态库。
const native = { skip: !process.env.LUASKILLS_LIB };
// Independent worker frames and retained receipts have explicit fixture capacities.
// 独立工作线程帧及保留回执拥有显式夹具容量。
const limits = Object.freeze({ workThreads: 1, maxWorkCommands: 2, maxControlCommands: 2 });

/**
 * Own a driver and borrowed native transport until every worker exits with drainage proof.
 * 拥有驱动及借用原生传输，直到全部工作线程带排空证明退出。
 * @param {Function} action Test body receiving exact owners.
 * 接收精确所有者的测试主体。
 * @returns {Promise<void>} Actual cleanup completion.
 * 实际清理完成。
 */
async function withDriver(action) {
  const transport = new EmbeddedTransport(budgets);
  const driver = new EmbeddedCommandDriver(transport, limits);
  try { await driver.ready(); await action(driver, transport); }
  finally { await driver.releaseResults(); await driver.close(); transport.close(); transport.free(); }
}

test("driver configuration rejects accessors and proxies without touching transport ownership", () => {
  let touched = 0;
  const transport = { claimDriver() { touched += 1; throw new Error("must not claim"); } };
  const getter = { ...limits, get workThreads() { touched += 1; return 1; } };
  const proxy = new Proxy(limits, { ownKeys() { touched += 1; return []; } });
  for (const config of [null, getter, proxy, { ...limits, extra: 1 }]) assert.throws(() => new EmbeddedCommandDriver(transport, config), /three data limits/);
  for (const value of [0, -1, true, 1n, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => new EmbeddedCommandDriver(transport, { ...limits, workThreads: value }), /positive safe integer/);
  assert.throws(() => new EmbeddedCommandDriver(transport, { ...limits, workThreads: 3 }), /exceeds/);
  assert.equal(touched, 0);
});

test("close before startup settles every ready observer and releases its transport claim", native, async () => {
  const transport = new EmbeddedTransport(budgets);
  const driver = new EmbeddedCommandDriver(transport, limits);
  try {
    const readiness = driver.ready().then(() => "ready", () => "closed");
    await driver.close();
    assert.equal(await Promise.race([readiness, delay(100).then(() => "pending")]), "closed");
    assert.equal(driver.status.closed, true);
  } finally {
    await driver.close();
    transport.close();
    transport.free();
  }
});

test("reserved worker frames and a single driver prevent premature transport release", native, async () => {
  const transport = new EmbeddedTransport({ ...budgets, max_result_buffers: 1 });
  try { assert.throws(() => new EmbeddedCommandDriver(transport, limits), /concurrent response frames/); }
  finally { transport.close(); transport.free(); }
  await withDriver(async (driver, owner) => {
    assert.equal(driver.status.workers, 2);
    assert.ok(EmbeddedCommandDriver.live.includes(driver));
    assert.throws(() => new EmbeddedCommandDriver(owner, limits), /already has a command driver/);
    assert.throws(() => owner.free(), /command driver/);
    await driver.close();
    assert.ok(!EmbeddedCommandDriver.live.includes(driver));
    const replacement = new EmbeddedCommandDriver(owner, limits);
    try { await replacement.ready(); } finally { await replacement.close(); }
  });
});

test("work receipts remain bounded after completion while the control lane stays available", native, async () => {
  await withDriver(async (driver) => {
    const first = driver.submit({ type: "describe" });
    const second = driver.submit({ type: "describe" });
    assert.throws(() => second.forget(), /completed/);
    assert.throws(() => driver.submit({ type: "describe" }), /receipt capacity/);
    const control = driver.submit({ type: "describe" }, "control");
    assert.equal((await control.result()).protocol_version, 1);
    assert.deepEqual(await first.result(), await second.result());
    assert.throws(() => driver.submit({ type: "describe" }), /receipt capacity/);
    first.forget();
    assert.throws(() => first.forget(), /exact retained/);
    const next = driver.submit({ type: "describe" });
    await next.result();
    assert.equal(Object.isFrozen(driver.commands), true);
    assert.deepEqual(driver.commands.map((receipt) => receipt.id), [second.id, control.id, next.id]);
  });
});

test("aborted observations preserve native reserve receipts and join all workers during close", native, async () => {
  await withDriver(async (driver, transport) => {
    const request = { type: "runtime_reserve" };
    const receipt = driver.submit(request);
    request.type = "unknown-command-after-submit";
    const abort = new AbortController();
    const reason = new Error("observer stopped waiting");
    abort.abort(reason);
    await assert.rejects(receipt.result({ signal: abort.signal }), (error) => error === reason);
    assert.equal(driver.commands[0], receipt);
    await assert.rejects(driver.close({ signal: abort.signal }), (error) => error === reason);
    assert.throws(() => transport.free(), /command driver/);
    const result = await receipt.result();
    assert.equal(transport.request({ type: "runtime_status", runtime_id: result.runtime_id }).initialization, "reserved");
    const copied = receipt.responseBytes;
    copied.fill(0);
    assert.deepEqual(receipt.deliveredResult(), result);
    transport.request({ type: "runtime_close", runtime_id: result.runtime_id });
    transport.request({ type: "runtime_free", runtime_id: result.runtime_id });
    await driver.close();
    assert.equal(driver.status.workers, 0);
    assert.equal(driver.status.closed, true);
  });
});

test("command encoding avoids accessors and async-hook reentrancy cannot exceed admission", native, async () => {
  await withDriver(async (driver) => {
    let touched = 0;
    assert.throws(() => driver.submit({ get type() { touched += 1; return "describe"; } }), /data|accessor/);
    assert.equal(touched, 0);
    assert.throws(() => driver.submit({ type: "runtime", runtime_id: "never-submitted", operation: { type: "operation_wait", operation_id: "never-submitted", wait_ms: 1 } }), /operation_wait/);
    assert.equal(driver.commands.length, 0);
    driver.submit({ type: "describe" });
    let entered = false;
    const hook = createHook({ init(_id, type) {
      if (type === "LuaSkillsEmbeddedCommand" && !entered) { entered = true; driver.submit({ type: "describe" }); }
    } });
    try {
      hook.enable();
      assert.throws(() => driver.submit({ type: "describe" }), /admission changed/);
    } finally { hook.disable(); }
    assert.equal(entered, true);
    assert.equal(driver.commands.length, limits.maxWorkCommands);
    await Promise.all(driver.commands.map((receipt) => receipt.result()));
  });
});

test("binding startup failure joins unused workers and preserves the borrowed transport", native, async () => {
  const transport = new EmbeddedTransport(budgets);
  const original = transport.libraryPath;
  // Deliberately shadow a read-only getter only at this test boundary to inject worker loading failure.
  // 仅在此测试边界刻意遮蔽只读 getter，注入工作线程加载失败。
  Object.defineProperty(transport, "libraryPath", { value: original + ".intentionally-missing", configurable: true });
  const driver = new EmbeddedCommandDriver(transport, limits);
  try {
    await assert.rejects(driver.ready(), /load|find|open|module/i);
    await driver.close();
    assert.equal(driver.status.closed, true);
    assert.equal(transport.request({ type: "describe" }).protocol_version, 1);
  } finally { delete transport.libraryPath; await driver.close(); transport.close(); transport.free(); }
});

test("native and business failures keep distinct identities across worker messages", native, async () => {
  await withDriver(async (driver) => {
    const malformed = driver.submit({ type: "unknown-command" });
    await assert.rejects(malformed.result(), (error) => error instanceof EmbeddedTransportError && error.status === EmbeddedNativeStatus.INVALID_ARGUMENT);
    const missing = driver.submit({ type: "runtime_status", runtime_id: "missing-exact-runtime" });
    await assert.rejects(missing.result(), (error) => error instanceof EmbeddedRuntimeError && error.code === "not_found");
    assert.throws(() => missing.deliveredResult(), EmbeddedRuntimeError);
    assert.equal(malformed.responseBytes, null);
    assert.equal(missing.done, true);
  });
});

test("ambiguous delivery rejects observers while preserving unreleased native ownership", native, () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./fixtures/embedded-driver-fault.mjs", import.meta.url))], { encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
});

test("actual worker initialization and Lua execution preserve explicit floating values", native, async () => {
  await withRuntime(async ({ driver, runtimeId, pool, terminal }) => {
    const poolId = pool("return {call=function(a) return a end}");
    const receipt = driver.submit({ type: "runtime", runtime_id: runtimeId, operation: { type: "call_submit", timeout_ms: 10000, call: { pool_id: poolId, export: "call", arguments: new EmbeddedFloat(1e100), context: { request_context: null, client_budget: null, tool_config: null } } } });
    const operation = await receipt.result();
    const done = await terminal(operation.operation_id);
    assert.equal(done.phase, "succeeded");
    assert.ok(done.value instanceof EmbeddedFloat);
    assert.equal(done.value.value, 1e100);
    receipt.forget();
  }, { driverConfig: limits });
});

test("the control worker delivers and acknowledges real callbacks while work receipts remain full", native, async () => {
  await withRuntime(async ({ driver, runtimeId, command, pool, submit, terminal, pluginId }) => {
    command({ type: "capabilities_register", descriptors: [{ name: "typescript.callback", version: "1.0.0", description: "Worker callback integration", input_schema: true, output_schema: true, execution: "queued", permissions: ["typescript.host"], scope: "invocation", max_concurrent: 1, max_call_ms: 10000, max_input_bytes: 1024, max_output_bytes: 1024, effects: "mutating", idempotency: "none" }] });
    const poolId = pool("return {call=function(a) return vulcan.capabilities.call('typescript.callback',a) end}");
    const operationId = submit(poolId, { plugin_id: "forged" });
    // Control completions return their own quota; full business receipts remain retained throughout.
    // 控制完成归还自身配额；满额业务回执在整个过程中继续保留。
    const control = async (operation) => {
      const receipt = driver.submit({ type: "runtime", runtime_id: runtimeId, operation }, "control");
      try { return await receipt.result(); } finally { receipt.forget(); }
    };
    const work = [driver.submit({ type: "describe" }), driver.submit({ type: "describe" })];
    const batch = await poll(() => control({ type: "host_requests_take", limit: 1 }), (requests) => requests.length !== 0);
    const request = batch[0];
    try {
      assert.equal(request.caller.plugin_id, pluginId);
      assert.equal(request.arguments.plugin_id, "forged");
      assert.throws(() => driver.submit({ type: "describe" }), /receipt capacity/);
      await control({ type: "operation_cancel", operation_id: operationId });
      assert.equal((await control({ type: "host_request_status", request_id: request.request_id })).phase, "dispatched");
    } finally {
      await control({ type: "host_request_complete", request_id: request.request_id, outcome: { ok: true, value: new EmbeddedFloat(1e100), effects: "committed" } });
    }
    const done = await terminal(operationId);
    assert.equal(done.phase, "cancelled");
    assert.ok(done.host_effects.some((effect) => effect.effects === "committed"));
    await Promise.all(work.map((receipt) => receipt.result()));
  }, { driverConfig: limits });
});
