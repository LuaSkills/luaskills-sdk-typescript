import assert from "node:assert/strict";
import { test } from "node:test";
import { EmbeddedTransport, EmbeddedFloat, EmbeddedNativeStatus, EmbeddedRuntimeError, EmbeddedResultReleaseError, EmbeddedTransportError } from "../dist/index.js";

// Real integration is enabled only by an explicit matching native library.
// 仅通过显式匹配原生库启用真实集成。
const native = { skip: !process.env.LUASKILLS_LIB };
import { budgets, poll, withRuntime } from "./embedded-fixture.mjs";

// Consume automatic closing from the actual DLL, preserving null and an independent closing failure.
// 从实际 DLL 消费自动关闭，保留空值及独立的关闭失败。
test("automatic finalization preserves both real Lua outcomes", native, async () => {
  await withRuntime(async ({ command, moduleDefinition, poolPolicy, submit, terminal }) => {
    const definition = moduleDefinition("local called=false; local fail=false; return {call=function(a) called=true; fail=a; return nil end, shutdown=function() assert(called); if fail then error('closing failed') end; return nil end}");
    definition.exports.push({ name: "shutdown", input_schema: true, output_schema: true });
    definition.finalizer = { export: "shutdown", arguments: null, timeout_ms: 1000 };
    const poolId = command({ type: "pool_register", definition, policy: { ...poolPolicy, reuse: "single_call" }, permissions: ["typescript.host"], execution_revision: "typescript-v1" }).pool_id;
    for (const fail of [false, true]) {
      const snapshot = await terminal(submit(poolId, fail));
      assert.equal(snapshot.phase, fail ? "failed" : "succeeded");
      assert.deepEqual(snapshot.finalization.business, { status: "succeeded", value: null });
      assert.equal(snapshot.finalization.business_effect_count, 0);
      if (fail) {
        assert.equal(snapshot.finalization.outcome.status, "failed");
        assert.deepEqual(snapshot.finalization.outcome.error, snapshot.error);
      } else {
        assert.deepEqual(snapshot.finalization.outcome, { status: "succeeded", value: null });
        assert.ok(Object.hasOwn(snapshot, "value"));
        assert.equal(snapshot.value, null);
      }
    }
  });
});

// Session shutdown exposes its reserved operation without rewriting an earlier business result.
// 会话关闭暴露其预留操作，不改写较早的业务结果。
test("session finalization preserves business and exposes its independent operation", native, async () => {
  await withRuntime(async ({ command, moduleDefinition, poolPolicy, terminal, pluginId }) => {
    const definition = moduleDefinition("local n=0; return {call=function() n=n+1; return tostring(n) end, shutdown=function() return tostring(n) end}");
    definition.exports.push({ name: "shutdown", input_schema: true, output_schema: true });
    definition.finalizer = { export: "shutdown", arguments: null, timeout_ms: 1000 };
    const poolId = command({ type: "pool_register", definition, policy: { ...poolPolicy, reuse: "session" }, permissions: ["typescript.host"], execution_revision: "typescript-v1" }).pool_id;
    const opening = command({ type: "session_open", pool_id: poolId, timeout_ms: 5000 });
    assert.equal((await terminal(opening.operation_id)).phase, "succeeded");
    assert.equal(command({ type: "plugin_status", plugin_id: pluginId }).reserved_operations, 1);
    const operationId = command({ type: "session_submit", session_id: opening.session_id, export: "call", arguments: null, context: { request_context: null, client_budget: null, tool_config: null }, timeout_ms: 5000 }).operation_id;
    const business = await terminal(operationId);
    assert.equal(business.value, "1");
    command({ type: "session_close", session_id: opening.session_id });
    const session = await poll(() => command({ type: "session_status", session_id: opening.session_id }), (status) => status.phase === "closed");
    assert.notEqual(session.finalization_operation, operationId);
    const closing = await terminal(session.finalization_operation);
    assert.equal(closing.phase, "succeeded");
    assert.deepEqual(closing.finalization.business, { status: "succeeded", value: null });
    assert.deepEqual(closing.finalization.outcome, { status: "succeeded", value: "1" });
    assert.deepEqual(command({ type: "operation_status", operation_id: operationId }), business);
    assert.equal(command({ type: "plugin_status", plugin_id: pluginId }).reserved_operations, 0);
  });
});

test("invalid budgets fail before loading a native library", () => {
  for (const value of [0, -1, 1.5, true, Number.MAX_SAFE_INTEGER + 1, 1n << 63n]) {
    assert.throws(() => new EmbeddedTransport({ ...budgets, max_runtimes: value }, { libraryPath: "missing-library" }), /integer|uint64|isize/);
  }
  assert.throws(() => new EmbeddedTransport({ ...budgets, max_response_bytes: budgets.max_result_bytes + 1 }, { libraryPath: "missing-library" }), /exceeds/);
  assert.throws(() => new EmbeddedTransport({ ...budgets, extra: 1 }), /five data budgets/);
  let invoked = 0;
  const getter = { ...budgets, get max_runtimes() { invoked += 1; return 1; } };
  assert.throws(() => new EmbeddedTransport(getter), /five data budgets/);
  assert.equal(invoked, 0);
});

test("real C ABI retains bigint budgets and independent transport ownership", native, () => {
  const first = new EmbeddedTransport({ ...budgets, max_runtimes: 9007199254740993n });
  const second = new EmbeddedTransport(budgets);
  try {
    assert.equal(typeof first.transportId, "bigint");
    assert.notEqual(first.transportId, second.transportId);
    assert.equal(first.request({ type: "describe" }).limits.max_runtimes, 9007199254740993n);
    assert.ok(Object.isFrozen(first.config));
    assert.ok(EmbeddedTransport.live.includes(first));
    assert.throws(() => first.free(), (error) => error instanceof EmbeddedTransportError && error.status === EmbeddedNativeStatus.BUSY);
    first.close(); first.free();
    assert.equal(first.transportId, null);
    assert.ok(!EmbeddedTransport.live.includes(first));
    assert.throws(() => first.request({ type: "describe" }), /live identity/);
    assert.equal(second.request({ type: "describe" }).protocol_version, 1);
  } finally {
    if (first.transportId !== null) { first.close(); first.free(); }
    second.close(); second.free();
  }
});

test("real Lua state, explicit JSON values and operation forgetting", native, async () => {
  await withRuntime(async ({ command, pool, submit, terminal }) => {
    const poolId = pool("local n=0; return {call=function(a) n=n+1; return {count=tostring(n),arg=a} end}");
    const argumentsValue = { text: "中文\0🦥", array: [], object: {}, null: null, boolean: false };
    for (const count of [1, 2]) {
      const operationId = submit(poolId, argumentsValue);
      const done = await terminal(operationId);
      assert.equal(done.phase, "succeeded", JSON.stringify(done));
      assert.deepEqual(done.value, { count: String(count), arg: argumentsValue });
      command({ type: "operation_forget", operation_id: operationId });
      assert.throws(() => command({ type: "operation_status", operation_id: operationId }), (error) => error instanceof EmbeddedRuntimeError && error.code === "not_found");
    }
    const nullPool = pool("return {call=function(a) return a end}");
    const nullResult = await terminal(submit(nullPool, null));
    assert.equal(nullResult.phase, "succeeded");
    assert.ok(Object.hasOwn(nullResult, "value"));
    assert.equal(nullResult.value, null);
    const floatResult = await terminal(submit(nullPool, new EmbeddedFloat(1e100)));
    assert.equal(floatResult.phase, "succeeded");
    assert.ok(floatResult.value instanceof EmbeddedFloat);
    assert.equal(floatResult.value.value, 1e100);
  });
});

test("release failure retains exact successful receipt without replay and blocks premature free", native, () => {
  const transport = new EmbeddedTransport(budgets);
  const release = transport.nativeResultFree;
  let runtimeId = null;
  try {
    let failure;
    transport.nativeResultFree = () => EmbeddedNativeStatus.BUSY;
    assert.throws(() => transport.request({ type: "runtime_reserve" }), (error) => { failure = error; return error instanceof EmbeddedResultReleaseError; });
    assert.equal(transport.retainedResults, 1);
    failure.responseBytes.fill(0);
    runtimeId = failure.deliveredResult().runtime_id;
    transport.close();
    assert.throws(() => transport.free(), /active calls or results/);
    transport.nativeResultFree = release;
    transport.releaseResults();
    assert.equal(transport.retainedResults, 0);
    assert.equal(transport.request({ type: "runtime_status", runtime_id: runtimeId }).initialization, "reserved");
  } finally {
    transport.nativeResultFree = release;
    transport.releaseResults(); transport.close();
    if (runtimeId !== null) transport.request({ type: "runtime_free", runtime_id: runtimeId });
    transport.free();
  }
});

test("thrown result-release binding errors preserve original business failure bytes", native, () => {
  const transport = new EmbeddedTransport(budgets);
  const release = transport.nativeResultFree;
  const cause = new Error("Injected before native result release");
  try {
    transport.nativeResultFree = () => { throw cause; };
    assert.throws(() => transport.request({ type: "runtime_status", runtime_id: "missing-exact-id" }), (error) => {
      assert.ok(error instanceof EmbeddedResultReleaseError);
      assert.equal(error.status, null);
      assert.equal(error.cause, cause);
      assert.throws(() => error.deliveredResult(), (delivered) => delivered instanceof EmbeddedRuntimeError && delivered.code === "not_found");
      return true;
    });
    assert.equal(transport.retainedResults, 1);
  } finally {
    transport.nativeResultFree = release;
    transport.releaseResults(); transport.close(); transport.free();
  }
});

test("native request errors release no result and reentrant cleanup cannot race an active reader", native, () => {
  const transport = new EmbeddedTransport(budgets);
  const release = transport.nativeResultFree;
  try {
    assert.throws(() => transport.request({ type: "unknown_command" }), (error) => error instanceof EmbeddedTransportError && error.status === EmbeddedNativeStatus.INVALID_ARGUMENT);
    assert.equal(transport.retainedResults, 0);
    transport.nativeResultFree = (identity, result) => {
      assert.throws(() => transport.releaseResults(), /active calls/);
      assert.throws(() => transport.free(), /active calls or results/);
      return release(identity, result);
    };
    assert.equal(transport.request({ type: "describe" }).protocol_version, 1);
    assert.equal(transport.retainedResults, 0);
  } finally {
    transport.nativeResultFree = release;
    transport.releaseResults(); transport.close(); transport.free();
  }
});

test("real queued callback retains trusted identity and late committed evidence after cancellation", native, async () => {
  await withRuntime(async ({ transport, pluginId, command, pool, submit, terminal }) => {
    const registration = command({ type: "capabilities_register", descriptors: [{ name: "typescript.callback", version: "1.0.0", description: "TypeScript integration callback", input_schema: true, output_schema: true, execution: "queued", permissions: ["typescript.host"], scope: "invocation", max_concurrent: 1, max_call_ms: 10000, max_input_bytes: 1024, max_output_bytes: 1024, effects: "mutating", idempotency: "none" }] }).registration_ids[0];
    const poolId = pool("return {call=function(a) return vulcan.capabilities.call('typescript.callback',a) end}");
    const operationId = submit(poolId, { plugin_id: "forged", value: null });
    const requests = await poll(() => command({ type: "host_requests_take", limit: 1 }), (batch) => batch.length > 0);
    assert.equal(requests.length, 1);
    const request = requests[0];
    try {
      assert.equal(request.registration_id, registration);
      assert.equal(request.caller.plugin_id, pluginId);
      assert.equal(request.caller.operation_id, operationId);
      assert.equal(request.arguments.plugin_id, "forged");
      command({ type: "operation_cancel", operation_id: operationId });
      transport.close();
      assert.throws(() => submit(poolId, null), (error) => error instanceof EmbeddedRuntimeError && error.code === "closed");
      assert.equal(command({ type: "host_request_status", request_id: request.request_id }).phase, "dispatched");
      assert.throws(() => transport.free(), (error) => error instanceof EmbeddedTransportError && error.status === EmbeddedNativeStatus.BUSY);
    } finally {
      command({ type: "host_request_complete", request_id: request.request_id, outcome: { ok: true, value: new EmbeddedFloat(1e100), effects: "committed" } });
    }
    const done = await terminal(operationId);
    assert.equal(done.phase, "cancelled");
    assert.ok(done.host_effects.some((effect) => effect.effects === "committed"));
  });
});
