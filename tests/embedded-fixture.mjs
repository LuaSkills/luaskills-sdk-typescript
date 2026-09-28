import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EmbeddedTransport, EmbeddedCommandDriver, EmbeddedClient, createEngineOptions } from "../dist/index.js";

// Shared fixture budgets fit complete bounded snapshots; individual tests override one declared constraint.
// 共享夹具预算容纳完整有界快照；单项测试覆盖一个声明约束。
export const budgets = Object.freeze({ max_runtimes: 1, max_result_buffers: 4, max_result_bytes: 131072, max_response_bytes: 32768, max_request_bytes: 65536 });

/**
 * Poll actual core evidence using a finite test deadline and short event-loop yields.
 * 使用有限测试截止时间和短事件循环让出来轮询实际核心证据。
 * @param {Function} read Read the current authoritative snapshot.
 * 读取当前权威快照。
 * @param {Function} complete Predicate for proven completion.
 * 已证明完成的判定函数。
 * @returns {Promise<object>} The actual satisfying snapshot.
 * 实际满足条件的快照。
 */
export async function poll(read, complete) {
  const deadline = performance.now() + 5000;
  while (true) {
    const snapshot = await read();
    if (complete(snapshot)) return snapshot;
    assert.ok(performance.now() < deadline, `Native drainage timed out: ${JSON.stringify(snapshot)}`);
    await delay(1);
  }
}

/**
 * Own one trusted module fixture through actual runtime cleanup, even when test assertions fail.
 * 拥有一个可信模块夹具直到实际运行时清理，即使测试断言失败也如此。
 * @param {Function} action Test body receiving the known runtime and package identity.
 * 接收已知运行时和包身份的测试主体。
 * @param {object} options Explicit optional driver/transport budgets and persistent fixture selection.
 * 显式可选驱动／传输预算与持久夹具选择。
 * @returns {Promise<void>} Resolves only after native runtime removal and transport release.
 * 仅在原生运行时移除及传输释放后完成。
 */
export async function withRuntime(action, { driverConfig = null, transportConfig = budgets, persistent = false, journalMaxRecords = 16 } = {}) {
  const root = mkdtempSync(join(tmpdir(), "luaskills-embedded-ts-"));
  const pluginId = "typescript-embedded-test";
  const systemRoot = join(root, "system_lua_lib");
  const packageRoot = join(systemRoot, pluginId);
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(join(packageRoot, "dependencies.yaml"), "{}\n");
  const transport = new EmbeddedTransport(transportConfig);
  let runtimeId = null;
  let driver = null;
  try {
    if (driverConfig !== null) {
      driver = new EmbeddedCommandDriver(transport, driverConfig);
      await driver.ready();
    }
    // Initialization uses the selected transport mode; completed test receipts immediately return their quota.
    // 初始化使用选定传输模式；已完成测试回执立即归还配额。
    const initialize = async (request) => {
      if (driver === null) return transport.request(request);
      const receipt = driver.submit(request);
      try { return await receipt.result(); } finally { receipt.forget(); }
    };
    runtimeId = (await initialize({ type: "runtime_reserve" })).runtime_id;
    const limits = { max_registered_plugins: 4, max_registered_pools: 4, max_sessions: 4, max_registered_capabilities: 4, max_resident_vms: 2, max_running_calls: 2, max_queued_calls: 4, max_queued_bytes: 4096, max_operations: 16, max_effect_records_per_operation: 8, max_effect_bytes_per_operation: 8192, max_host_requests: 4, max_host_request_bytes: 8192, max_value_bytes: 1024 };
    const engineOptions = createEngineOptions({ runtimeRoot: root, hostOptions: { system_lua_lib_dir: systemRoot, allow_network_download: false } });
    if (persistent) {
      assert.notEqual(driver, null, "Persistent fixture requires the typed driver's lifecycle");
      // The facade carries the same explicit path and budget declaration as the core ABI.
      // 外观携带与核心 ABI 相同的显式路径和预算声明。
      const pending = new EmbeddedClient(driver).runtime(runtimeId).initialize(engineOptions, limits, {
        path: join(root, "operations.db"),
        journal: { max_records: journalMaxRecords, max_record_bytes: 32768, max_database_bytes: 262144 },
        worker: { max_pending_writes: 8, max_pending_bytes: 131072 },
      });
      try { await pending.result(); } finally { pending.forget(); }
    } else {
      await initialize({ type: "runtime_initialize", runtime_id: runtimeId, engine_options: engineOptions, runtime_config: limits });
    }
    const status = transport.request({ type: "runtime_status", runtime_id: runtimeId });
    assert.equal(status.initialization, "ready", JSON.stringify(status));
    // Commands bind one exact runtime identity; no name-based lookup or fallback is involved.
    // 命令绑定一个精确运行时身份；不涉及名称查找或回退。
    const command = (operation) => transport.request({ type: "runtime", runtime_id: runtimeId, operation });
    const pluginConfig = Object.fromEntries(["max_registered_pools", "max_sessions", "max_resident_vms", "max_running_calls", "max_queued_calls", "max_queued_bytes", "max_operations"].map((key) => [key, limits[key]]));
    command({ type: "plugin_register", plugin_id: pluginId, config: pluginConfig });
    // Each pool carries an immutable source generation and explicit shared reuse policy.
    // 每个池携带不可变源码代次及显式公共复用策略。
    const moduleDefinition = (source) => ({ plugin_id: pluginId, generation: "typescript-generation-1", package_root: packageRoot, dependencies_file: "dependencies.yaml", workspace_root: null, cwd: null, mounts: {}, security_partition: "typescript-test", source, exports: [{ name: "call", input_schema: true, output_schema: true }] });
    const poolPolicy = { kind: "shared", min_resident_vms: 0, max_resident_vms: 2, max_running_calls: 2, max_queued_calls: 4, reuse: "reusable", serial: false, backend: "in_process", idle_ttl_ms: null, max_uses: null };
    const pool = (source) => command({ type: "pool_register", definition: moduleDefinition(source), policy: poolPolicy, permissions: ["typescript.host"], execution_revision: "typescript-v1" }).pool_id;
    // Admission returns only an operation identity, never an inferred successful business result.
    // 入场仅返回操作身份，绝不推断业务结果成功。
    const submit = (poolId, argumentsValue) => command({ type: "call_submit", timeout_ms: 10000, call: { pool_id: poolId, export: "call", arguments: argumentsValue, context: { request_context: null, client_budget: null, tool_config: null } } }).operation_id;
    const terminal = (operationId) => poll(() => command({ type: "operation_status", operation_id: operationId }), (snapshot) => ["succeeded", "failed", "cancelled"].includes(snapshot.phase));
    await action({ transport, driver, runtimeId, engineOptions, runtimeConfig: limits, pluginId, pluginConfig, moduleDefinition, poolPolicy, command, pool, submit, terminal });
  } finally {
    if (driver !== null) { await driver.releaseResults(); await driver.close(); }
    transport.releaseResults();
    transport.close();
    if (runtimeId !== null) {
      await poll(() => transport.request({ type: "runtime_status", runtime_id: runtimeId }), (status) => status.closed);
      transport.request({ type: "runtime_free", runtime_id: runtimeId });
    }
    transport.free();
    rmSync(root, { recursive: true, force: true });
  }
}
