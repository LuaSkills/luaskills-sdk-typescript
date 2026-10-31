import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { sdk } from "./load-sdk.mjs";

/** Execute the documented action/binding/input request; return JSON rows or changes.
 * 执行文档化的 action/binding/input 请求；返回 JSON 行或变更数。
 * The host owns connection lifetime, parameter binding and transaction rollback.
 * 宿主负责连接生命周期、参数绑定及事务回滚。
 */
export function sqliteProvider(request) {
  // Skill input cannot override the core-owned binding path.
  // 技能输入不能覆盖核心绑定路径。
  const databasePath = request.binding.default_database_path;
  mkdirSync(dirname(databasePath), { recursive: true });
  // Fresh connections prove that each successful write reached the database file.
  // 全新连接确保每次成功写入均已保存到数据库文件。
  const database = new DatabaseSync(databasePath);
  try {
    switch (request.action) {
      case "execute_script":
        database.exec(request.input.sql);
        return { ok: true };
      case "execute_batch": {
        database.exec("BEGIN");
        try {
          for (const statement of request.input.statements) {
            database.prepare(statement.sql).run(...statement.params);
          }
          database.exec("COMMIT");
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
        return { ok: true };
      }
      case "query_json": {
        // Lua empty tables encode as objects; only an empty object denotes zero parameters.
        // Lua 空表编码为对象；仅空对象表示零个参数。
        const parameters = request.input.params;
        const bindings = !Array.isArray(parameters) && Object.keys(parameters).length === 0 ? [] : parameters;
        return { rows: database.prepare(request.input.sql).all(...bindings), database_path: databasePath };
      }
      default:
        throw new Error(`unsupported SQLite demo action: ${request.action}`);
    }
  } finally {
    database.close();
  }
}

/** Run write/read engines against an isolated SQLite skill and retain its data; return nothing.
 * 对隔离 SQLite 技能运行写入及读取引擎，并保留数据；无返回值。
 */
export function main() {
  // Resolve the installed core independently of the demo's newly created data directory.
  // 独立于示例新建数据目录解析已安装核心。
  const ffi = new sdk.LuaSkillsJsonFfi({ libraryPath: process.env.LUASKILLS_LIB, runtimeRoot: process.env.LUASKILLS_RUNTIME_ROOT ?? "luaskills-runtime" });
  const runtimeRoot = mkdtempSync(join(tmpdir(), "luaskills-sqlite-node-"));
  const skill = join(runtimeRoot, "user_skills", "sqlite-demo");
  const fixture = JSON.parse(readFileSync(new URL("./sqlite-demo-fixture.json", import.meta.url), "utf8"));
  mkdirSync(join(skill, "runtime"), { recursive: true });
  writeFileSync(join(skill, "skill.yaml"), fixture.manifest);
  writeFileSync(join(skill, "runtime", "run.lua"), fixture.lua);
  // Quotes and SQL syntax must survive as data, including Unicode.
  // 引号和 SQL 语法必须保留为数据，同时包含 Unicode。
  const note = "宿主 SQLite: '); DROP TABLE notes; --";
  try {
    for (const write of [true, false]) {
      ffi.setSqliteProviderJsonCallback(sqliteProvider);
      // Each engine captures this generation before the default callback is cleared.
      // 每个引擎在默认回调清空前捕获当前代次。
      const client = sdk.LuaSkillsClient.create({ libraryPath: ffi.libraryPath, runtimeRoot, hostOptions: { host_mode: "desktop", sqlite_callback_mode: "json" } });
      try {
        ffi.clearSqliteProviderJsonCallback();
        client.loadFromRoots(sdk.RuntimeRoots.standard(runtimeRoot));
        const result = client.callSkill("sqlite-demo-run", { write, text: note });
        assert.match(result.content, /^sqlite-demo:ok:/);
        console.log(result.content);
      } finally {
        client.close();
      }
    }
  } finally {
    ffi.clearSqliteProviderJsonCallback();
  }
}
