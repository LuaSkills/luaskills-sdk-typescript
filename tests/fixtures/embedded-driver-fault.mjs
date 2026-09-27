import assert from "node:assert/strict";
import { EmbeddedCommandDriver, EmbeddedTransport } from "../../dist/index.js";
import { budgets } from "../embedded-fixture.mjs";

// Isolate an intentionally unrecoverable message-boundary failure in its own disposable process.
// 将故意不可恢复的消息边界失败隔离在单独的一次性进程中。
const transport = new EmbeddedTransport(budgets);
const driver = new EmbeddedCommandDriver(transport, { workThreads: 1, maxWorkCommands: 1, maxControlCommands: 1 });
await driver.ready();
const send = driver.send;
const failure = new Error("Injected ambiguous request delivery");
driver.send = function (slot, message) {
  if (message.type === "request") throw failure;
  return send.call(this, slot, message);
};
try {
  const receipt = driver.submit({ type: "describe" });
  await assert.rejects(receipt.result(), (error) => error === failure);
  assert.equal(receipt.done, false);
  assert.throws(() => receipt.forget(), /completed/);
  await assert.rejects(driver.close(), (error) => error === failure);
  assert.equal(driver.status.closed, false);
  assert.throws(() => transport.free(), /command driver/);
  assert.ok(EmbeddedCommandDriver.live.includes(driver));
} finally {
  // Only this crash-test process terminates its workers; no request reached C and production never uses terminate.
  // 仅此崩溃测试进程终止其工作线程；没有请求进入 C，产品代码从不使用 terminate。
  await Promise.all(driver.workers.map((slot) => slot.worker.terminate()));
}
assert.equal(driver.status.closed, false);
assert.throws(() => transport.free(), /command driver/);
