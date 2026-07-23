import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LuaSkillsClient } from "../dist/index.js";

// Explicit native library path enables the real JSON FFI integration test.
// 显式原生库路径用于启用真实 JSON FFI 集成测试。
const nativeLibrary = process.env.LUASKILLS_LIB;

if (nativeLibrary) {
  // Isolated host root owns runtime layout, skill packages, and persistent configuration.
  // 隔离宿主根目录保存运行时布局、技能包与持久化配置。
  const hostRoot = mkdtempSync(join(tmpdir(), "luaskills-config-e2e-"));
  // Runtime root satisfies unrelated fixed engine layout requirements.
  // 运行时根目录满足其他固定引擎布局要求。
  const runtimeRoot = join(hostRoot, "runtime");
  // User-level configuration root is independent from package installation roots.
  // 用户级配置根目录独立于技能包安装根目录。
  const configRoot = join(hostRoot, "config");
  // ROOT package directory verifies dedicated system-skill configuration routing.
  // ROOT 技能包目录验证专用系统技能配置路由。
  const rootSkills = join(hostRoot, "root-skills");
  // USER package directory verifies ordinary configuration routing.
  // USER 技能包目录验证普通配置路由。
  const userSkills = join(hostRoot, "user-skills");

  try {
    writeConfigSkill(rootSkills, "system-config-e2e");
    writeConfigSkill(userSkills, "user-config-e2e");

    // Client uses the just-built native library and an explicit configuration root.
    // 客户端使用刚构建的原生库与显式配置根目录。
    const client = LuaSkillsClient.create({
      libraryPath: nativeLibrary,
      runtimeRoot,
      hostOptions: {
        skill_config_root: configRoot,
        skill_config_lock_timeout_ms: 5_000,
        skill_config_watch_debounce_ms: 20,
      },
    });
    try {
      client.loadFromRoots([
        { name: "ROOT", skills_dir: rootSkills },
        { name: "USER", skills_dir: userSkills },
      ]);

      // Initial descriptor proves all common declaration types cross the native boundary.
      // 初始描述符证明所有常见声明类型均能穿过原生边界。
      const descriptor = client.config.describe({
        skillId: "user-config-e2e",
      })[0];
      assert.equal(descriptor.skill_id, "user-config-e2e");
      assert.deepEqual(
        descriptor.items.map((item) => item.type),
        ["string", "integer", "float", "enum", "boolean"],
      );
      assert.equal(client.config.validate("user-config-e2e").complete, false);

      // One batch transaction exercises typed values and returns its CAS revision.
      // 单个批量事务覆盖类型化值并返回其 CAS 修订号。
      const written = client.config.set("user-config-e2e", {
        token: "secret",
        retries: 4,
        ratio: 0.5,
        mode: "fast",
        enabled: true,
      });
      assert.equal(written.changed, true);
      assert.deepEqual(written.changed_keys, [
        "enabled",
        "mode",
        "ratio",
        "retries",
        "token",
      ]);
      assert.equal(client.config.validate("user-config-e2e").complete, true);
      assert.equal(client.config.get("user-config-e2e", "retries").value, "4");
      // Raw user records proving store-origin metadata reaches the SDK.
      // 证明存储来源元数据抵达 SDK 的原始用户记录。
      const userEntries = client.config.list("user-config-e2e");
      assert.equal(userEntries.length, 5);
      assert.ok(
        userEntries.every((entry) => entry.store_scope === "skills"),
      );

      // Stale compare-and-swap revision must not overwrite the committed snapshot.
      // 过期的比较并交换修订号不得覆盖已提交快照。
      assert.throws(
        () =>
          client.config.set(
            "user-config-e2e",
            "retries",
            5,
            { expectedRevision: "0" },
          ),
        /CONFIG_REVISION_CONFLICT/,
      );
      // Declaration validation must reject the full invalid transaction atomically.
      // 声明校验必须原子拒绝整个非法事务。
      assert.throws(
        () =>
          client.config.set(
            "user-config-e2e",
            { retries: 99, enabled: false },
            { expectedRevision: written.revision },
          ),
        /CONFIG_VALUE_OUT_OF_RANGE/,
      );
      assert.equal(client.config.get("user-config-e2e", "enabled").value, "true");

      // ROOT-owned writes are persisted only in the dedicated system-skills store.
      // ROOT 所属写入仅持久化到专用 system-skills 存储。
      client.config.set("system-config-e2e", {
        token: "system-secret",
        retries: 1,
        ratio: 1.0,
        mode: "safe",
        enabled: false,
      });
      assert.equal(
        JSON.parse(
          readFileSync(join(configRoot, "system-skills", "config.json"), "utf8"),
        ).skills["system-config-e2e"].token,
        "system-secret",
      );
      assert.equal(
        JSON.parse(readFileSync(join(configRoot, "skills", "config.json"), "utf8"))
          .skills["system-config-e2e"],
        undefined,
      );

      // Event polling exposes both ordered local transactions without skipping pages.
      // 事件轮询按顺序公开两个本地事务且不会跳页。
      const firstPage = client.config.pollEvents(undefined, 1);
      assert.equal(firstPage.events.length, 1);
      const secondPage = client.config.pollEvents(firstPage.next_sequence, 10);
      assert.ok(secondPage.events.length >= 1);
    } finally {
      client.close();
    }
  } finally {
    rmSync(hostRoot, { recursive: true, force: true });
  }
}

/**
 * Create one valid package containing every common configuration declaration type.
 * 创建一个包含所有常见配置声明类型的合法技能包。
 *
 * @param skillsRoot Physical root containing package directories.
 * @param skillId Stable package identifier.
 * @returns No value.
 * @param skillsRoot 包含技能包目录的物理根目录。
 * @param skillId 稳定技能包标识符。
 * @returns 无返回值。
 */
function writeConfigSkill(skillsRoot, skillId) {
  // Package directory owns its manifest and one inert Lua entry.
  // 技能包目录保存其清单与一个无副作用 Lua 入口。
  const packageRoot = join(skillsRoot, skillId);
  mkdirSync(join(packageRoot, "runtime"), { recursive: true });
  writeFileSync(
    join(packageRoot, "skill.yaml"),
    `name: ${skillId}
version: 1.0.0
enable: true
debug: false
config:
  - key: token
    type: string
    required: true
    sensitive: true
    description: Access token
    constraints:
      min_length: 1
      max_length: 128
  - key: retries
    type: integer
    default: 3
    description: Retry count
    constraints:
      minimum: 0
      maximum: 10
  - key: ratio
    type: float
    default: 0.25
    description: Sampling ratio
    constraints:
      minimum: 0.0
      maximum: 1.0
  - key: mode
    type: enum
    default: safe
    description: Execution mode
    options:
      - value: safe
        label: Safe
        description: Conservative mode
      - value: fast
        label: Fast
        description: Fast mode
  - key: enabled
    type: boolean
    default: false
    description: Feature switch
entries:
  - name: ping
    description: Return a stable response.
    lua_entry: runtime/main.lua
    lua_module: ${skillId}.main
`,
    "utf8",
  );
  writeFileSync(
    join(packageRoot, "runtime", "main.lua"),
    "return function() return 'ok' end\n",
    "utf8",
  );
}
