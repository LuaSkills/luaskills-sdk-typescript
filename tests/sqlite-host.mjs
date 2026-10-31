import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LuaSkillsClient, LuaSkillsJsonFfi, RuntimeRoots } from "../dist/index.js";
import { main, sqliteProvider } from "../examples/sqlite-demo.mjs";

// Native tests require explicit core bytes; mocked callbacks are not SQLite acceptance evidence.
// 原生测试要求显式核心字节；模拟回调不能作为 SQLite 验收证据。
const native = { skip: !process.env.LUASKILLS_LIB };

// Run the exact packaged demo, including rollback and fresh-engine persistence assertions.
// 运行精确的包内示例，包含回滚及全新引擎持久化断言。
test("packaged SQLite demo runs through actual Lua and FFI", native, main);

// Existing engines retain different callback generations across replacement, clearing and later-engine free.
// 在替换、清空及释放较新引擎时，既有引擎保留不同的回调代次。
test("SQLite generations stay with their original engines", native, () => {
  // The fixture creates only isolated data owned by this test.
  // 夹具仅创建此测试拥有的隔离数据。
  const root = mkdtempSync(join(tmpdir(), "luaskills-sqlite-generations-"));
  const skill = join(root, "user_skills", "sqlite-demo");
  const fixture = JSON.parse(readFileSync(new URL("../examples/sqlite-demo-fixture.json", import.meta.url), "utf8"));
  mkdirSync(join(skill, "runtime"), { recursive: true });
  writeFileSync(join(skill, "skill.yaml"), fixture.manifest);
  writeFileSync(join(skill, "runtime/run.lua"), fixture.lua);
  const ffi = new LuaSkillsJsonFfi({ libraryPath: process.env.LUASKILLS_LIB });
  // Windows aliases share a slot; an older facade cannot clear a newer owner's default.
  // Windows 别名共享槽位；旧外观不能清空新所有者的默认值。
  const replacement = new LuaSkillsJsonFfi({ libraryPath: process.platform === "win32" ? ffi.libraryPath.toUpperCase() : ffi.libraryPath });
  const calls = [0, 0];
  /** Capture index; return a real SQLite adapter that counts this generation's requests.
   * 捕获 index；返回统计当前代次请求的真实 SQLite 适配器。
   */
  const provider = (index) => (request) => { calls[index]++; return sqliteProvider(request); };
  try {
    ffi.setSqliteProviderJsonCallback(provider(0));
    const first = LuaSkillsClient.create({ libraryPath: ffi.libraryPath, runtimeRoot: root, hostOptions: { sqlite_callback_mode: "json" } });
    try {
      replacement.setSqliteProviderJsonCallback(provider(1));
      ffi.clearSqliteProviderJsonCallback();
      const second = LuaSkillsClient.create({ libraryPath: ffi.libraryPath, runtimeRoot: root, hostOptions: { sqlite_callback_mode: "json" } });
      try {
        replacement.clearSqliteProviderJsonCallback();
        first.loadFromRoots(RuntimeRoots.standard(root));
        second.loadFromRoots(RuntimeRoots.standard(root));
        first.callSkill("sqlite-demo-run", { write: true, text: "captured A/B" });
        assert.ok(calls[0] > 0);
        assert.equal(calls[1], 0);
        second.callSkill("sqlite-demo-run", { write: false, text: "captured A/B" });
        assert.ok(calls[1] > 0);
      } finally { second.close(); }
      first.callSkill("sqlite-demo-run", { write: false, text: "captured A/B" });
    } finally { first.close(); }
  } finally {
    replacement.clearSqliteProviderJsonCallback();
    ffi.clearSqliteProviderJsonCallback();
    rmSync(root, { recursive: true, force: true });
  }
});
