import assert from "node:assert/strict";
import { EmbeddedCallbackPump, HostCapability } from "../../dist/index.js";
import { EmbeddedCallbackExecutor } from "../../dist/embedded-driver.js";
import { withRuntime } from "../embedded-fixture.mjs";

// An isolated process contains an intentionally unrecoverable worker message-boundary fault.
// 独立进程容纳故意不可恢复的工作线程消息边界故障。
const failure = new Error("Injected ambiguous callback publication delivery");
const original = EmbeddedCallbackExecutor.prototype.submit;
let executor = null;
EmbeddedCallbackExecutor.prototype.submit = function (command, lane) {
  if (command.type === "runtime" && command.operation.type === "capabilities_register") {
    executor = this;
    const send = this.send;
    this.send = function (slot, message) {
      if (message.type === "request") throw failure;
      return send.call(this, slot, message);
    };
  }
  return original.call(this, command, lane);
};
await withRuntime(async ({ transport, runtimeId }) => {
  const pump = new EmbeddedCallbackPump(transport, runtimeId, { maxConcurrentHandlers: 1, maxPendingCommands: 1, pollIntervalMs: 2 });
  await pump.ready();
  try {
    const descriptor = { name: "typescript.callback", version: "1.0.0", description: "Publication message fault", input_schema: true, output_schema: true, execution: "queued", permissions: ["typescript.host"], scope: "invocation", max_concurrent: 1, max_call_ms: 10000, max_input_bytes: 1024, max_output_bytes: 1024, effects: "mutating", idempotency: "none" };
    await assert.rejects(pump.register([new HostCapability(descriptor, () => null)]), (error) => error === failure);
    await assert.rejects(pump.close({ signal: AbortSignal.timeout(1000) }), (error) => error === failure);
    assert.equal(pump.status.closed, false);
    assert.equal(pump.status.pendingCommands, 1);
    assert.ok(EmbeddedCallbackPump.live.includes(pump));
    assert.throws(() => transport.free(), /callback pump/);
  } finally {
    EmbeddedCallbackExecutor.prototype.submit = original;
    // Only this fixture terminates workers and releases its claim; the injected request provably never reached C.
    // 仅此夹具终止线程并释放声明；已证明注入故障的请求从未进入 C。
    await Promise.all(executor.workers.map((slot) => slot.worker.terminate()));
    transport.releaseCallbackPump(runtimeId, executor);
  }
});
