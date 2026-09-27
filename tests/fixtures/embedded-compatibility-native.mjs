import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { once } from "node:events";
import { EmbeddedTransport } from "../../dist/index.js";
import { bindEmbeddedNative } from "../../dist/embedded-transport.js";
import { budgets } from "../embedded-fixture.mjs";

// Keep both independently loaded module instances alive throughout the failed borrow attempt.
// 在失败借用尝试全过程中保持两个独立加载模块实例存活。
const transport = new EmbeddedTransport(budgets);
try {
  const duplicate = bindEmbeddedNative(process.argv[2]);
  assert.deepEqual(duplicate.descriptionBytes, bindEmbeddedNative(transport.libraryPath).descriptionBytes);
  assert.notEqual(duplicate.bindingIdentity, transport.bindingIdentity);
  const worker = new Worker(new URL("../../dist/embedded-worker.js", import.meta.url), {
    execArgv: [], workerData: { libraryPath: process.argv[2], bindingIdentity: transport.bindingIdentity,
      transportId: transport.transportId, maxRequestBytes: transport.config.max_request_bytes, maxResponseBytes: transport.config.max_response_bytes },
  });
  const exit = once(worker, "exit");
  const reply = (await once(worker, "message"))[0];
  assert.equal(reply.type, "startup_failed");
  assert.equal(reply.error.kind, "compatibility");
  assert.equal((await exit)[0], 0);
  assert.equal(transport.request({ type: "describe" }).protocol_version, 1);
} finally { transport.close(); transport.free(); }
