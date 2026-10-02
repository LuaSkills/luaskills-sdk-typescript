import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { test } from "node:test";
import { EmbeddedClient, EmbeddedCommand, EmbeddedCommandDriver, EmbeddedTransport, EmbeddedRuntime, EmbeddedCallbackPump, EmbeddedRuntimeScope, EmbeddedRuntimeError, EmbeddedResultReleaseError, EmbeddedNativeStatus, decodeEmbeddedJson } from "../dist/index.js";
import { EmbeddedScopeExecutor } from "../dist/embedded-driver.js";
import { bindEmbeddedNative, requestEmbeddedNative } from "../dist/embedded-transport.js";
import { errorEvidence } from "../dist/embedded-worker-runtime.js";
import { runEmbeddedCandidate } from "../examples/embedded-candidate.mjs";

// This regression is an explicit native gate, with no environment discovery or skip path.
// 此回归是显式原生门禁，没有环境发现或跳过路径。
assert.equal(process.argv.length, 4, "Usage: node tests/embedded-candidate-native.mjs <absolute-library> <absolute-description.json>");
assert.ok(isAbsolute(process.argv[2]) && isAbsolute(process.argv[3]), "Native regression inputs must be absolute");

// Cover cleanup success and a second real unused-scope-worker startup failure while no pump exists.
// 覆盖清理成功，以及无泵时第二个真实未使用作用域线程启动失败。
for (const failScopeStartup of [false, true]) test(`reserve release failure preserves native ownership with scope startup failure=${failScopeStartup}`, { timeout: 20000 }, async () => {
  // Save exact SDK boundaries; mutations are restored even when regression assertions fail.
  // 保存精确 SDK 边界；即使回归断言失败也恢复变更。
  const originalSend = EmbeddedCommandDriver.prototype.send;
  const originalReserve = EmbeddedClient.prototype.reserve;
  const originalResult = EmbeddedCommand.prototype.result;
  // Observe exact slot removal immediately before actual root transport release.
  // 在实际根传输释放前立即观察精确槽移除。
  const originalFree = EmbeddedTransport.prototype.free;
  // Startup injection waits for actual unused-worker readiness before failing its owned lifecycle.
  // 启动注入等待实际未使用线程就绪后，才使其拥有型生命周期失败。
  const originalScopeReady = EmbeddedScopeExecutor.prototype.ready;
  const startupError = new Error("Injected unused scope worker startup failure");
  // Actual DLL bindings and native descriptor ownership are separate from the simulated delivery boundary.
  // 实际 DLL 绑定及原生描述符所有权独立于模拟交付边界。
  const native = bindEmbeddedNative(process.argv[2]);
  const owners = new Map();
  // Preserve the same pending, driver, transport and failure identities across observation and cleanup.
  // 跨观察及清理保留同一待完成回执、驱动器、传输及失败身份。
  let reservation = null;
  let driver = null;
  let transport = null;
  let retainedSlot = null;
  let originalError = null;
  let reserves = 0;
  let actualReleases = 0;
  // Query only the recovered original identity, never an inferred replacement slot.
  // 仅查询恢复的原身份，绝不查询推测的替代槽。
  let removedOriginalSlot = false;
  EmbeddedClient.prototype.reserve = function () {
    reservation = originalReserve.call(this);
    return reservation;
  };
  EmbeddedCommand.prototype.result = async function (options) {
    try { return await originalResult.call(this, options); }
    catch (error) { if (reservation !== null && this === reservation.receipt) originalError = error; throw error; }
  };
  EmbeddedTransport.prototype.free = function () {
    if (this === transport) {
      assert.throws(() => this.request({ type: "runtime_status", runtime_id: reservation.deliveredResult().runtimeId }), (error) => error instanceof EmbeddedRuntimeError && error.code === "not_found");
      removedOriginalSlot = true;
    }
    return originalFree.call(this);
  };
  if (failScopeStartup) EmbeddedScopeExecutor.prototype.ready = async function () {
    await originalScopeReady.call(this);
    throw startupError;
  };
  EmbeddedCommandDriver.prototype.send = function (slot, message) {
    if (message.type === "request" && decodeEmbeddedJson(message.bytes).command.type === "runtime_reserve") {
      reserves += 1;
      driver = this;
      transport = this.borrowedTransport;
      retainedSlot = slot;
      // Allocate the actual runtime and response in the frozen DLL, but fail its first free before entering C.
      // 在冻结 DLL 内分配真实运行时及响应，但首次释放在进入 C 前失败。
      try {
        requestEmbeddedNative(transport.transportId, Buffer.from(message.bytes), transport.config.max_response_bytes, owners, native.request, () => EmbeddedNativeStatus.BUSY);
        assert.fail("The injected result-free must fail");
      } catch (error) {
        assert.ok(error instanceof EmbeddedResultReleaseError);
        assert.equal(owners.size, 1, "Real native result must remain retained");
        queueMicrotask(() => this.onMessage(slot, { type: "completed", id: message.id, bytes: null, error: errorEvidence(error), retained: true }));
      }
      return;
    }
    if (message.type === "release" && slot === retainedSlot) {
      // Recover that exact retained descriptor through the real DLL, without resubmitting reserve.
      // 通过真实 DLL 恢复该精确保留描述符，不重新提交预留。
      for (const [allocation, result] of owners) {
        assert.equal(native.resultFree(transport.transportId, result), EmbeddedNativeStatus.OK);
        actualReleases += 1;
        owners.delete(allocation);
      }
      queueMicrotask(() => this.onMessage(slot, { type: "released", id: message.id, error: null, retained: false }));
      return;
    }
    return originalSend.call(this, slot, message);
  };
  try {
    await assert.rejects(runEmbeddedCandidate(process.argv[2], readFileSync(process.argv[3])), (error) => {
      assert.ok(originalError instanceof EmbeddedResultReleaseError);
      assert.equal(originalError.status, EmbeddedNativeStatus.BUSY);
      if (!failScopeStartup) return error === originalError;
      assert.ok(error instanceof AggregateError);
      assert.equal(error.cause, originalError);
      assert.equal(error.errors.length, 2);
      assert.ok(error.errors.includes(originalError), "Original release error object must be retained");
      assert.ok(error.errors.includes(startupError), "Actual scope startup error object must be retained");
      return true;
    });
    if (failScopeStartup) {
      assert.equal(driver.status.closed, false);
      assert.equal(EmbeddedCommandDriver.live.includes(driver), true);
      assert.equal(driver.commands.includes(reservation.receipt), true, "Original reserve receipt must remain discoverable after actual unused-worker exit");
      assert.equal(EmbeddedRuntimeScope.live.length, 0, "Failed unused scope must release only its own worker claim");
      assert.equal(EmbeddedCallbackPump.live.length, 0, "This recovery path must have no pump retaining the runtime identity");
      // The exact original typed and raw views must recover one identical reserved slot.
      // 精确原始类型化及原始视图必须恢复同一个预留槽。
      const recovered = reservation.deliveredResult();
      assert.equal(reservation.receipt.deliveredResult().runtime_id, recovered.runtimeId);
      assert.equal(transport.request({ type: "runtime_status", runtime_id: recovered.runtimeId }).initialization, "reserved");
      EmbeddedScopeExecutor.prototype.ready = originalScopeReady;
      // Recovery is explicitly requested by the test after inspection, never replayed by the example.
      // 测试检查后显式请求恢复，示例绝不重放。
      const scope = new EmbeddedRuntimeScope(recovered);
      await scope.ready();
      await scope.close();
      assert.equal(scope.status.phase, "closed");
      reservation.forget();
      await driver.close();
      transport.close();
      transport.free();
    }
    assert.equal(reserves, 1, "Original reservation must never be replayed");
    assert.equal(actualReleases, 1, "Exact real response allocation must be released once");
    assert.equal(owners.size, 0);
    assert.equal(removedOriginalSlot, true);
    assert.equal(driver.status.closed, true);
    assert.equal(EmbeddedCommandDriver.live.includes(driver), false);
    assert.equal(transport.transportId, null, "Successful transport free proves the original runtime slot was removed");
    assert.equal(EmbeddedRuntimeScope.live.length, 0);
  } finally {
    EmbeddedCommandDriver.prototype.send = originalSend;
    EmbeddedClient.prototype.reserve = originalReserve;
    EmbeddedCommand.prototype.result = originalResult;
    EmbeddedTransport.prototype.free = originalFree;
    EmbeddedScopeExecutor.prototype.ready = originalScopeReady;
  }
});

test("one actual scope startup failure preserves the healthy reserve receipt and exact existing pump", { timeout: 20000 }, async () => {
  // Keep original SDK methods so the healthy native reserve and initialization execute unchanged.
  // 保留 SDK 原方法，使健康原生预留及初始化保持原样执行。
  const originalReserve = EmbeddedClient.prototype.reserve;
  const originalInitialize = EmbeddedRuntime.prototype.initialize;
  const originalScopeReady = EmbeddedScopeExecutor.prototype.ready;
  // One sentinel is the only injected failure; no result-release or business failure is added.
  // 一个哨兵是唯一注入失败；不增加结果释放或业务失败。
  const startupError = new Error("Injected healthy-path unused scope startup failure");
  // Retain actual identities and the precise example-owned temporary path for explicit recovery.
  // 保留实际身份及精确示例拥有临时路径，以进行显式恢复。
  let reservation = null;
  let driver = null;
  let exampleRoot = null;
  let reserves = 0;
  EmbeddedClient.prototype.reserve = function () {
    reserves += 1;
    driver = this.driver;
    reservation = originalReserve.call(this);
    return reservation;
  };
  EmbeddedRuntime.prototype.initialize = function (options, limits, persistence) {
    exampleRoot = dirname(options.host_options.system_lua_lib_dir);
    return originalInitialize.call(this, options, limits, persistence);
  };
  EmbeddedScopeExecutor.prototype.ready = async function () {
    await originalScopeReady.call(this);
    throw startupError;
  };
  try {
    await assert.rejects(runEmbeddedCandidate(process.argv[2], readFileSync(process.argv[3])), (error) => error === startupError);
    assert.equal(reserves, 1);
    assert.equal(driver.status.closed, false);
    assert.equal(EmbeddedCommandDriver.live.includes(driver), true);
    assert.equal(driver.commands.includes(reservation.receipt), true);
    // Recovery reads the same receipt's copied identity without issuing another reserve.
    // 恢复读取同一回执的复制身份，不发起另一预留。
    const runtime = reservation.deliveredResult();
    const transport = driver.borrowedTransport;
    assert.equal(reservation.receipt.deliveredResult().runtime_id, runtime.runtimeId);
    assert.equal(transport.request({ type: "runtime_status", runtime_id: runtime.runtimeId }).closing, false);
    // Existing-pump adoption must preserve the exact callback ownership already established by the example.
    // 已有泵接管必须保留示例已经建立的精确回调所有权。
    const pump = EmbeddedCallbackPump.live.find((candidate) => candidate.runtimeId === runtime.runtimeId);
    assert.notEqual(pump, undefined);
    assert.equal(EmbeddedRuntimeScope.live.length, 0);
    EmbeddedScopeExecutor.prototype.ready = originalScopeReady;
    const scope = new EmbeddedRuntimeScope(runtime, { pump });
    await scope.ready();
    await scope.close();
    assert.equal(scope.status.phase, "closed");
    assert.equal(pump.status.closed, true);
    assert.throws(() => transport.request({ type: "runtime_status", runtime_id: runtime.runtimeId }), (error) => error instanceof EmbeddedRuntimeError && error.code === "not_found");
    reservation.forget();
    await driver.close();
    transport.close();
    transport.free();
    assert.equal(driver.status.closed, true);
    assert.equal(transport.transportId, null);
    // Remove only the exact temporary directory created by this example after all native owners have released it.
    // 全部原生所有者释放后，仅移除此示例创建的精确临时目录。
    assert.equal(dirname(resolve(exampleRoot)), resolve(tmpdir()));
    assert.ok(basename(exampleRoot).startsWith("luaskills-embedded-example-"));
    rmSync(exampleRoot, { recursive: true, force: true });
  } finally {
    EmbeddedClient.prototype.reserve = originalReserve;
    EmbeddedRuntime.prototype.initialize = originalInitialize;
    EmbeddedScopeExecutor.prototype.ready = originalScopeReady;
  }
});
