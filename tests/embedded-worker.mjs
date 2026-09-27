import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { MessageChannel, Worker } from "node:worker_threads";
import { EmbeddedTransport, EmbeddedNativeStatus, EmbeddedTransportError, encodeEmbeddedJson } from "../dist/index.js";
import { bindEmbeddedNative, decodeEmbeddedResponse } from "../dist/embedded-transport.js";
import { serveEmbeddedWorker } from "../dist/embedded-worker-runtime.js";
import { budgets, withRuntime, poll } from "./embedded-fixture.mjs";

// Only explicit matching native builds enable these actual C ABI ownership checks.
// 仅显式匹配原生构建启用这些实际 C ABI 所有权检查。
const native = { skip: !process.env.LUASKILLS_LIB };

/**
 * Borrow exact transport startup values; no worker owns native transport creation or release.
 * 借用精确传输启动值；工作线程不拥有原生传输创建或释放。
 * @param {EmbeddedTransport} transport Existing owner.
 * 现有所有者。
 * @returns {object} Exact immutable startup fields.
 * 精确不可变启动字段。
 */
function configuration(transport) {
  return { libraryPath: transport.libraryPath, transportId: transport.transportId, maxRequestBytes: transport.config.max_request_bytes, maxResponseBytes: transport.config.max_response_bytes };
}

for (const failure of ["status", "throw"]) {
  test(`worker protocol preserves real native allocations and copied evidence after ${failure} release failure`, native, async () => {
    const transport = new EmbeddedTransport(budgets);
    const bindings = bindEmbeddedNative(transport.libraryPath);
    const { port1, port2 } = new MessageChannel();
    let injected = true;
    let requests = 0;
    // Only result release is fault-injected; allocation and request processing use the actual DLL.
    // 仅在结果释放处注入故障；分配及请求处理使用实际 DLL。
    const boundary = { ...bindings,
      request(...args) { requests += 1; return bindings.request(...args); },
      resultFree(...args) {
        if (injected) {
          if (failure === "throw") throw new Error("Injected result release exception");
          return EmbeddedNativeStatus.BUSY;
        }
        return bindings.resultFree(...args);
      },
    };
    // One sequential protocol exchange captures its listener before publishing a message.
    // 一次顺序协议交互在发布消息之前捕获监听器。
    const exchange = async (request) => { const response = once(port1, "message"); port1.postMessage(request); return (await response)[0]; };
    const readiness = once(port1, "message");
    serveEmbeddedWorker(configuration(transport), port2, boundary);
    try {
      assert.equal((await readiness)[0].type, "ready");
      const response = await exchange({ type: "request", id: "describe-once", bytes: Uint8Array.from(encodeEmbeddedJson({ protocol_version: 1, command: { type: "describe" } }, budgets.max_request_bytes)) });
      assert.equal(response.type, "completed");
      assert.equal(response.id, "describe-once");
      assert.equal(response.retained, true);
      assert.equal(response.error.kind, "release");
      assert.equal(response.error.status, failure === "throw" ? null : EmbeddedNativeStatus.BUSY);
      assert.equal(decodeEmbeddedResponse(response.error.responseBytes).protocol_version, 1);
      assert.equal(response.error.responseBytes.byteLength, response.error.responseBytes.buffer.byteLength);
      transport.close();
      assert.throws(() => transport.free(), (error) => error instanceof EmbeddedTransportError && error.status === EmbeddedNativeStatus.BUSY);
      const failedRecovery = await exchange({ type: "release", id: "retry-failed" });
      assert.equal(failedRecovery.retained, true);
      assert.notEqual(failedRecovery.error, null);
      injected = false;
      const recovered = await exchange({ type: "release", id: "retry-success" });
      assert.equal(recovered.id, "retry-success");
      assert.equal(recovered.retained, false);
      assert.equal(recovered.error, null);
      assert.equal(requests, 1);
    } finally {
      injected = false;
      await exchange({ type: "release", id: "cleanup" });
      assert.equal((await exchange({ type: "stop" })).type, "stopped");
      port1.close(); port2.close();
      transport.close(); transport.free();
    }
  });
}

test("a real blocking native wait leaves the main event loop and independent control worker available", native, async () => {
  await withRuntime(async ({ transport, driver, runtimeId, command, pool, submit }) => {
    command({ type: "capabilities_register", descriptors: [{ name: "typescript.callback", version: "1.0.0", description: "Blocked worker control test", input_schema: true, output_schema: true, execution: "queued", permissions: ["typescript.host"], scope: "invocation", max_concurrent: 1, max_call_ms: 10000, max_input_bytes: 1024, max_output_bytes: 1024, effects: "mutating", idempotency: "none" }] });
    const operationId = submit(pool("return {call=function(a) return vulcan.capabilities.call('typescript.callback',a) end}"), null);
    // Driver admission deliberately rejects blocking waits; test the shared executor directly in one extra worker.
    // 驱动入场明确拒绝阻塞等待；在额外一个工作线程中直接验证共享执行器。
    const worker = new Worker(new URL("./fixtures/embedded-worker-native.mjs", import.meta.url), { workerData: configuration(transport), execArgv: [] });
    const exited = once(worker, "exit");
    await once(worker, "message");
    let completed = false;
    const result = new Promise((resolve, reject) => {
      worker.once("error", reject);
      worker.on("message", (message) => { if (message.type === "completed") { completed = true; resolve(message); } });
    });
    const entered = once(worker, "message");
    worker.postMessage({ type: "request", id: "blocking-wait", bytes: Uint8Array.from(encodeEmbeddedJson({ protocol_version: 1, command: { type: "runtime", runtime_id: runtimeId, operation: { type: "operation_wait", operation_id: operationId, wait_ms: 5000 } } }, budgets.max_request_bytes)) });
    let request = null;
    // The independent control lane returns each local receipt quota after observing actual completion.
    // 独立控制通道在观察实际完成后归还每个本地回执配额。
    const control = async (operation) => {
      const receipt = driver.submit({ type: "runtime", runtime_id: runtimeId, operation }, "control");
      try { return await receipt.result(); } finally { receipt.forget(); }
    };
    try {
      assert.equal((await entered)[0].type, "native_entered");
      const batch = await poll(() => control({ type: "host_requests_take", limit: 1 }), (requests) => requests.length > 0);
      request = batch[0];
      assert.equal(completed, false, "Blocking native wait returned before independent control delivery");
      assert.equal((await control({ type: "host_request_status", request_id: request.request_id })).phase, "dispatched");
    } finally {
      if (request !== null) await control({ type: "host_request_complete", request_id: request.request_id, outcome: { ok: true, value: null, effects: "committed" } });
      else command({ type: "operation_cancel", operation_id: operationId });
      const response = await result;
      const stopped = once(worker, "message");
      worker.postMessage({ type: "stop" });
      assert.equal((await stopped)[0].type, "stopped");
      assert.equal((await exited)[0], 0);
      assert.equal(response.error, null, JSON.stringify(response.error));
      const completedOperation = decodeEmbeddedResponse(response.bytes);
      assert.equal(completedOperation.phase, "succeeded");
      assert.ok(completedOperation.host_effects.some((effect) => effect.effects === "committed"));
    }
  }, { driverConfig: { workThreads: 1, maxWorkCommands: 2, maxControlCommands: 2 } });
});
