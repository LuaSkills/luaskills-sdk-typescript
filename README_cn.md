# @luaskills/sdk

中文文档。英文默认文档见 [README.md](README.md)。

LuaSkills 主仓库：[LuaSkills/luaskills](https://github.com/LuaSkills/luaskills)

TypeScript / Node.js SDK，用于通过公共 JSON FFI 接入 LuaSkills 运行时。

`0.5.7` 是当前发布版本。它沿用严格的技能包级配置契约，并将运行时资产默认值设为 LuaSkills core `v0.5.7`、vldb-controller `v0.2.3` 与 vldb-sqlite `v0.1.6`。

SDK 封装了原生动态库加载、JSON FFI buffer、engine 生命周期、正式 skill root、带权限语义的管理调用、skill config、provider callback、宿主工具 callback 与 runtime 资产安装。宿主在常规集成中不需要手写底层 FFI buffer 或 JSON 包络。

## 嵌入式运行时契约（开发中）

通过 `initialize(engineOptions, runtimeConfig, persistence = null)` 显式启用持久模式。省略存储参数保持纯内存行为。传入生成配置，完整声明宿主管理的绝对 `path`、`journal` 保留预算及 `worker` 回执预算；SDK 不补造存储默认值，也不回退。初始化回执只确认尝试，实际结果须查询原生状态。状态包含可选实际存储所有权，协调关闭等待核心、写入者及保留回执排空。

运行时 `storageStatus / recoverStorage` 提供写入者所有权观测与同一原文件的显式恢复；`historyGet / historyNext / historyForget` 按原**核心运行时命名空间**访问历史，该身份区别于 FFI 槽 ID。历史与恢复走工作通道；存储状态及操作方法 `persistenceFailure / retryCheckpoint` 走控制通道。恢复不自动重试检查点或重放业务；无失败检查点时重试报告忙碌，返回假表示已有重试尚未完成。历史枚举使用原键游标，不提供跨调用快照。

`recoverStorageWorker` 仅在受监督失败线程实际退出且全部排队／活动尝试已由监督器处理后，独立重建写入线程。健康运行时返回假；显式写入者关闭、未证实退出或中毒所有权明确拒绝。原回执、字节／数量预留及同一存储所有者保留，不重放旧写入或业务；数据库恢复及原检查点重试仍是独立显式操作。运行时关闭期间，原核心仍在排空且写入者尚未永久关闭时，仍可恢复线程。

历史不会变成活动句柄。管理对账或删除前须先遗忘仍保留的活动操作。`historyReconcile` 附加一份最终、有界宿主证明，保留原始快照、调用方及副作用身份。可信宿主必须授权对账者、证明全部原执行及外部所有者已停止，并核验整个操作及每条副作用；对账者字符串不是认证。普通 Lua 的未知副作用不能从成功返回推断。使用原命名空间、操作 ID 及前驱修订；存储恢复后精确重试同一证明可确认同一后继。返回修订用于显式删除。此 API 不查询外部系统、不重放回调、不制造中断执行结果，也不恢复失败写入者或执行栈。开发磁盘格式为第 4 版，拒绝未发布的第 1–3 版且不改写原文件；必须使用匹配的开发核心与 SDK 契约。

`embeddedContract` 导出生成的请求／响应类型、逐命令响应映射及精确契约摘要。包内 `contracts/embedded/v1/` 复制自正在开发的核心，输入与输出类型分别反映 Rust 反序列化和序列化规则。`EmbeddedNativeStatus` 也从包顶层导出。这是开发契约，现有已发布的 0.5.7 原生库不提供新增嵌入式运行时 API。`EmbeddedTransport` 向显式选择的匹配库绑定一个只读发现导出及五个传输导出。固定命令工作线程、自动回调泵、类型句柄及协调生命周期作用域均已实现；完整持久恢复仍属于后续里程碑。

原生分配前，`EmbeddedTransport` 复制由动态库拥有且长度有界的 `luaskills_ffi_embedded_describe_v1` 字节，检查精确核心、协议、ABI 和描述版本、包内契约摘要、必需命令／能力、支持的后端、进程系统及指针位宽。缺少发现入口或元数据不兼容抛出 `EmbeddedCompatibilityError`；原生状态失败仍为 `EmbeddedTransportError`。借用描述字节绝不能交给结果释放函数。`coreDescription` 返回独立类型快照，释放后仍可读取。构建输入摘要仅描述选定输入，不认证二进制，也不证明完整封闭构建。

工作线程在就绪前检查同样的元数据，并比较由稳定的库内描述地址和精确描述字节派生的进程内不透明绑定标记。匹配核心保证该地址在库保持加载时稳定，因此拥有独立原生注册表的同内容库副本不能借用另一加载实例的传输 ID。标记仅用于进程内相等性检查，不是认证凭证或发布身份。传输保留动态库，直到工作线程实际退出且原生所有权释放；其 `libraryPath` 只读。宿主须使用不可变版本资产路径，在替换或卸载资产前完成旧实例清理。启动兼容错误经线程消息保留为 `EmbeddedCompatibilityError`，所有权声明仍等待实际线程退出才归还。

宽整数使用 `EmbeddedInteger`（`number | bigint`），超出 JavaScript 安全整数范围时必须使用 `bigint`。`encodeEmbeddedJson(value, maxBytes)` 和 `decodeEmbeddedJson(bytes)` 完整保留有符号／无符号 64 位整数，不将数字变成字符串。不安全的普通整数 number 会被拒绝：精确整数使用 `bigint`，包括 `1e100` 在内的显式有限浮点数使用 `new EmbeddedFloat(value)`。整数形浮点词元解码为 `EmbeddedFloat`（通过 `.value` 读取）；有小数部分的词元解码为普通 number，负零保持不变。不能对这些值使用普通 `JSON.stringify`。运行时授权和生命周期规则仍由核心负责；显式 JSON 空值与省略字段使用不同类型。建议启用 `strict` 和 `exactOptionalPropertyTypes`。

`EmbeddedTransport` 要求五项完整正数预算：`max_runtimes`、`max_result_buffers`、`max_result_bytes`、`max_response_bytes`、`max_request_bytes`，内部保留不可变 bigint 副本，使用既有 SDK 的显式动态库选择。`request(command)` 为同步调用；初始化或原生等待不能阻塞负责回调的事件循环。`close()` 请求关闭入场；调用方仍须完成实际宿主确认、排空并移除各运行时，再调用 `free()`。核心拒绝后所有者仍可用于清理。终结器和垃圾回收不替代原生释放，`EmbeddedTransport.live` 提供强保留所有者的冻结快照。构造时绑定异常且发布无法确认会继续保留动态库，需要基础设施恢复，不能据此声称可安全卸载。

结果字节先复制，再释放精确原生描述符。`EmbeddedResultReleaseError` 保留独立 `responseBytes` 副本；`deliveredResult()` 可恢复原有成功或业务错误，不重复执行命令。释放绑定抛异常时 `status === null` 并保留 `cause`，与实际数字 C 状态区分。`releaseResults()` 仅重试保留缓冲的释放，有活动读取者时拒绝，不重放业务。释放失败阻止传输 `free()`；复制证据缺失或无效时明确拒绝。编码会拒绝 getter、代理、序列化钩子、稀疏／带额外字段数组、undefined、非有限数和无效 Unicode，避免静默改变输入。

`EmbeddedCommandDriver(transport, { workThreads, maxWorkCommands, maxControlCommands })` 借用传输并启动固定业务 Worker 及一个独立控制 Worker。先等待 `ready()`，再通过 `submit(command, "work" | "control")` 同步取得回执；通过 `receipt.result({ signal })` 观察实际回复。入场先冻结有界 JSON 字节，跨线程仅传精确身份和独立字节，不克隆应用类对象或整个 Buffer 池。配置只接受三个正安全整数数据字段；原生结果预算必须容纳全部工作线程同时返回的最大帧。直接调用底层传输等额外并发需要另留容量；核心仍会拒绝超额请求。

两条通道分别限制排队、运行及已完成但未遗忘的全部回执。`commands` 和 `EmbeddedCommandDriver.live` 提供冻结所有者快照；`receipt.forget()` 仅归还已完成的本地回执配额，不删除核心操作。取消 `ready()`、`result()` 或 `close()` 的观察不会终止实际调用；原有回执及响应字节仍可读取。驱动拒绝阻塞式 `operation_wait`，应轮询 `operation_status`。控制通道用于查询、取消和宿主确认，调用方不能将初始化等长操作放入该通道。

工作线程复制响应后才释放原生结果；释放失败会暂停该线程后续入场，保留描述符及原始交付字节，`driver.releaseResults()` 显式恢复精确释放，不重放业务。驱动 `close()` 拒绝新命令，完成已接纳命令，并等待全部 Worker 的停止确认及实际退出后归还传输声明；它不关闭借用的原生运行时或传输。应先完成所有宿主处理器确认，再关闭命令驱动，随后按原生生命周期清理。启动前关闭会拒绝就绪观察并继续等待实际线程退出。没有排空证明的线程异常退出或消息发送故障会保留传输声明并显式报告基础设施故障，需要进程级恢复；不会强杀线程、自动替换执行器或重试业务。

`EmbeddedCallbackPump(transport, runtimeId, { maxConcurrentHandlers, maxPendingCommands, pollIntervalMs })` 为已初始化运行时保留一个额外的独立控制 Worker；同一传输和运行时只能有一个泵。传输预算统一检查普通驱动与所有泵的最大同时响应帧。先等待 `pump.ready()`，再使用 `pump.register([new HostCapability(descriptor, handler)])` 注册显式 `queued` 能力。完整描述符在入场时按传输字节预算复制冻结，处理器按精确注册 ID 路由，不按可变名称查找；新注册只对新池快照生效，旧池不能重定向到替换处理器。不要通过原始命令为该运行时添加其他队列处理器。

处理器接收结构化参数和 `HostCallbackContext`，支持同步返回值及 Promise。可信 `caller` 与应用参数分离且不可变；`signal`、`cancellation` 和 `throwIfCancelled()` 只观察核心取消，`remainingMs` 是精确 bigint 参考时长。`reportEffects()` 显式报告事务事实；变更类默认 unknown，只读类默认 not_applicable，不从成功或取消推断提交。处理器实际返回后封存副作用，复制冻结确认数据，清除 SDK 对可变返回值的别名。普通异常使用不包含秘密的通用错误，显式 SDK 错误保留有效协议分类；无效或超大输出转为保留原副作用的有界失败。Lua 能力调用返回含 ok、value 或 error、effects 的信封，处理器失败不自动等于外层 Lua 操作失败。

JavaScript 处理器在拥有泵的 Node 事件循环运行；同步处理器必须短小，不能阻塞等待或执行长时间 CPU 工作，耗时 I/O 应返回 Promise。返回的 Promise 必须覆盖处理器的全部工作；脱离它的后台任务不在泵的所有权范围。`maxConcurrentHandlers` 包括等待确认的完成结果；`maxPendingCommands` 限制尚未结束或交付不确定的注册批次。注销按已有注册共享排空等待，关闭和恢复不消耗注册入场配额。`pump.status` 和 `EmbeddedCallbackPump.live` 保留可查询身份。取消注册、注销或关闭的观察不丢弃真实拥有状态；从处理器等待自己的泵会明确拒绝。

`pump.unregister(id)` 等待原生及 JavaScript 实际排空，再遗忘核心注册元数据；`pump.close()` 停止接纳和取出新回调，注销拥有注册，完成实际处理器与确认后才等待 Worker 退出。注销不会伪造运行中处理器的取消；需要中断操作时使用核心取消申请或运行时关闭，并继续等待协作处理器真实返回。泵不关闭借用运行时或传输。完成泵排空后，再完成普通驱动及原生运行时的生命周期清理。

响应异常导致的注册、请求提取、注销和元数据遗忘都保留原始命令回执，不自动重放。恢复已提取批次时先安装精确请求，再将此前尚未启动的各处理器执行一次，不重复原生提取；`status.pendingExtraction` 和 `status.needsResultRelease` 公布尚未确认的提取及缓冲恢复所有权。未确认的宿主完成结果继续占用处理器名额，故障会停止新的回调入场。`retryAcknowledgements()` 显式回收失败缓冲，并用原始回执或精确操作副作用记录核对实际完成；仅在核心证明请求仍待确认时重新交付原冻结确认，不重新执行处理器。not_found 或 already_completed 本身不作为已完成证据。缺少交付证据时保留所有权；工作线程终止性基础设施故障会拒绝关闭观察，不宣称成功或释放缺少证明的声明。持久崩溃恢复日志仍属于后续实施，不把这些内存证据当作持久恢复。

`EmbeddedClient(driver)` 提供运行时、插件、池、固定会话和操作的类型句柄。`client.reserve()` 立即返回 `EmbeddedPending<EmbeddedRuntime>`；原生变更保留原始回执，直到显式 `forget()`。`pending.result({ signal })` 观察交付，`pending.deliveredResult()` 从复制证据恢复释放失败前的交付，`pending.map()` 只为同一回执建立本地视图。投影失败或观察取消后，原始证据仍保留在驱动器中。这些句柄借用驱动器；使用 `EmbeddedRuntimeScope` 接管并协调原生生命周期清理。

`new EmbeddedRuntimeScope(runtime, { pump, pollIntervalMs })` 接管一个已知运行时及其已有回调泵；无泵时可在初始化前接管预留槽。构造只分配独立控制线程和所有权，不初始化或关闭运行时；`ready()` 只证明该线程就绪。已有泵必须精确匹配传输及运行时，不能遗漏；接管后禁止新建泵、重复作用域和独立类型化 `runtime.free()`。作用域、泵和普通驱动的最坏响应帧统一计入传输预算，关闭不依赖普通驱动回执余量，也不关闭共享驱动、根传输或其他运行时。低层原始命令仍要求宿主自行遵守所有权顺序。

`scope.close({ signal })` 依次关闭原生入场、等待真实宿主回调及泵退出、轮询核心排空、移除精确槽并汇合控制线程。即使信号已中止，关闭仍被启动并强保留；取消只结束本次观察。也可使用 `await using scope = new EmbeddedRuntimeScope(runtime)`，离开作用域时等待相同关闭流程。长时间未返回的宿主处理器会延长真实排空，不能用观察超时假装已释放。`EmbeddedRuntimeScope.live` 与 `scope.status` 保留可发现的所有权及检查点。

失败后的普通 `close()` 观察原尝试；`retryClose()` 显式恢复原始交付、保留缓冲或核心已证明未变更的根容量拒绝。复制的移除成功先推进检查点，即使后续缓冲释放失败也不会再次移除槽。每个消费的控制响应必须标识精确运行时；状态检查点还要求 `closed` 为布尔值，初始化状态属于生成契约。无效证据保留原回执及所有权；重试重新校验该回执，不重新提交原生变更。回调泵需要证据恢复时明确报告，重试先恢复原泵；不重新执行处理器。无法证明释放时保留作用域声明；仅未发出原生命令的启动失败可在线程实际退出后撤销声明。运行时槽释放会移除其操作记录，宿主需要长期保存的副作用证据应在关闭前持久化；完整持久恢复仍待整体方案后续实施。

`runtime.initialize(engineOptions, runtimeConfig)` 是单次构造尝试；必须查询 `runtime.status()` 区分预留、初始化中、就绪、失败及故障，初始化回执本身不代表成功。`runtime.registerPlugin()` 设置聚合预算；`runtime.registerPool()` 保留不可变定义、显式权限及执行修订。`pool.submit()` 和 `session.submit()` 返回操作身份回执，不是 Lua 完成结果；`pool.openSession()` 同时返回会话及独立可查询的初始化操作。句柄身份不可重定向；已知身份构造器不探测或推断原生存在性。

`operation.wait({ signal, pollIntervalMs })` 使用预留控制通道轮询真实核心快照，仅自动消费成功的只读查询回执，并返回含副作用证据的成功、失败或取消终态。使用 `AbortSignal`（包括 `AbortSignal.timeout`）限制观察时长，不会因此取消原生执行。`operation.cancel()` 独立请求协作取消；`operation.forget()` 移除核心记录，与遗忘 SDK 回执相互独立。中断或失败的查询仍可通过 `driver.commands` 找回。轮询在入场前校验正整数定时器边界；实现受控依赖跟踪前，宿主回调中的普通驱动器及生命周期等待明确返回不支持，包括跨运行时等待。

现有 `createEngineOptions()` 已可与生成的嵌入式输入契约组合使用。其 JSON 选项结构调整为结构化类型别名，不再支持对原接口进行声明合并；缓存配置使用生成契约中的三个数字字段，不接受任意 JSON。完整显式引擎选项必须提供 `enable_managed_io_compat`；构建器仍允许部分覆盖，并按现有规则合并嵌套能力及控制器默认值。旧 JSON 选项继续使用 `number`，需要精确 bigint 预算时使用生成的嵌入式类型。这些是后续统一版本的开发迁移变化，不代表已发布 0.5.7 动态库已更新。

执行 `npm run generate:embedded-contract` 可完全离线重新生成；`node scripts/generate-embedded-contract.mjs --check` 只读比较。显式同步新核心产物时使用 `--source <path/to/contract.json>`，相邻摘要和 README 必须存在。未知 Schema、重复 JSON 成员、缺失局部引用、冲突输出定义、标识符冲突及命令覆盖漂移均使生成失败。npm 包包含生成器及完整契约，不依赖开发机仓库路径。

`npm pack` 在构建前检查生成文件。针对该精确本地产物执行 `node scripts/verify-embedded-distribution.mjs <archive.tgz>`，可比较嵌入式成员字节，在新进程导入包内编译契约，并运行独立生成器。此开发验证器需要系统 `tar` 命令；普通离线生成只需 Node.js。契约 CI 覆盖 Linux、Windows、macOS 上的 Node 24／26，不代表原生嵌入式运行时验收。

## 安装

0.5.7 SDK 要求 Node.js 24 LTS 或更高版本。

```bash
npm install @luaskills/sdk
```

npm 包不内置原生 runtime 二进制文件或 LuaRocks 模块。请先用 `install-runtime` 准备 `runtimeRoot`；如果宿主自行管理原生文件，也可以显式传入 `libraryPath` / `LUASKILLS_LIB`。

```powershell
npx @luaskills/sdk install-runtime --database none --runtime-root D:\runtime\luaskills
npx @luaskills/sdk version --runtime-root D:\runtime\luaskills
```

Linux 与 macOS 会使用安装在 `runtimeRoot/libs` 下的 `.so` / `.dylib` 动态库。

## Runtime 资产

npm 包还提供不依赖 Node.js CLI 的统一同步脚本，可直接拉取 LuaSkills FFI、Lua runtime packages 与 VLDB：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/deps/sync_runtime_assets.ps1 -Target all -Database vldb-controller -RuntimeRoot D:\runtime\luaskills
```

```bash
RUNTIME_ROOT=/opt/luaskills scripts/deps/sync_runtime_assets.sh all vldb-controller
```

目标支持 `all`、`luaskills`、`lua`、`vldb`；VLDB 模式支持 `none`、`vldb-controller`、`vldb-direct`、`host-callback`。脚本默认固定 LuaSkills `v0.5.7`，并允许显式覆盖发布版本。

`install-runtime` 会下载 GitHub Release 资产、校验 `.sha256` 旁路文件、解压原生文件与 Lua runtime 包，并写入：

```text
runtimeRoot/resources/luaskills-sdk-runtime-manifest.json
```

支持的数据库模式：

- `none`：安装 Lua runtime 归档与 LuaSkills FFI SDK 归档，但不安装数据库 provider。
- `vldb-direct`：安装 `vldb-sqlite-lib` 与 `vldb-lancedb-lib` 动态库，并使用 `dynamic_library` provider 模式。
- `vldb-controller`：安装 `vldb-controller`，并使用托管的 `space_controller` provider 模式。
- `host-callback`：不安装 VLDB 二进制文件，只生成 `host_callback + json` 宿主配置。

默认 LuaSkills 资产：

- `LuaSkills/luaskills-packages` 发布的 `lua-runtime-packages-{platform}.tar.gz`：默认安装；提供 `lua_packages`、packages 侧运行时 `libs`、`resources` 与第三方运行时授权材料。
- `luaskills-ffi-sdk-{platform}.tar.gz`：默认安装；提供公共 FFI 动态库、头文件与 FFI 授权材料。
- `lua-deps-{platform}.tar.gz`：SDK 不默认安装；它是 CI、源码构建或高级原生模块重建使用的构建期依赖包。

受管 Python 与 Node.js 子运行时是可选项。当 Lua skill 需要 `vulcan.runtime.python.*` 或 `vulcan.runtime.node.*` 时，使用 `--managed-runtimes all`；安装器会把 Python、`uv`、Node.js 与 `pnpm` 放入 `runtimeRoot/dependencies/runtimes/...`。

受管子运行时支持 Windows x64、Linux x64/ARM64 与 macOS x64/ARM64。Windows ARM 会在任何下载或目标目录创建前被明确拒绝。npm 包还包含 `scripts/deps/fetch_managed_runtimes.ps1`、`scripts/deps/fetch_managed_runtimes.sh` 与 `scripts/debug-tools/managed_runtime_layout_check.py` 独立工具，用于准备和校验 debug 运行时根目录。

当前受管依赖精确版本为 Python `3.14.6`、uv `0.11.28`、Node.js `24.18.0`、pnpm `11.11.0`。除非宿主有意安装其他受支持版本，否则包内 `dependencies.yaml` 必须声明相同的运行时与包管理器精确版本。

### 宿主指定受管运行时根

LuaSkills 0.5.1 将 LuaSkills 数据根、只读解释器发行根和可写受管环境根拆分为三个边界。两个显式受管根都必须是绝对路径；未设置时继续使用兼容的 `runtimeRoot/dependencies/runtimes` 与 `runtimeRoot/dependencies/envs` 布局。

```ts
import { LuaSkillsClient } from "@luaskills/sdk";

const distributionRoot = "D:/VulcanCode/dependencies/runtimes";
const client = LuaSkillsClient.create({
  runtimeRoot: "D:/VulcanCodeData/luaskills",
  hostOptions: {
    managed_runtime_distribution_root: distributionRoot,
    managed_runtime_environment_root: "D:/VulcanCodeData/managed-runtime-envs",
    managed_runtime_config: {
      worker_pool_max_size_per_environment: 8,
      worker_idle_ttl_secs: 120,
      persistent_session_limit_per_engine: 128,
      persistent_session_default_buffer_limit_bytes_per_stream: 2 * 1024 * 1024,
      invoke_default_timeout_ms: 30_000,
    },
  },
});

const pythonInstall = LuaSkillsClient.resolveManagedRuntimeInstall({
  runtimeRoot: "D:/VulcanCodeData/luaskills",
  distributionRoot,
  runtime: "python",
  version: "3.14.6",
  platform: "windows-x64",
});
```

`defaultManagedRuntimeConfig()` 返回稳定引擎默认值：单个精确环境/包所有者池 `4` 个 Worker、空闲 `60` 秒、`256` 个持久会话、每个 Session 输出流 `1 MiB`，且 invoke 无默认超时。调整单项时应从这份完整对象开始。所有配置数值必须为正；单次 `invoke.timeout_ms` 与单个 Session 的 `session.open.buffer_limit_bytes` 只覆盖各自对应的引擎默认值。

独立拉取与调试工具通过 `-DistributionRoot` 或 `MANAGED_RUNTIME_DISTRIBUTION_ROOT` 接受同一拆分布局，并通过 `--distribution-root` 与 `--environment-root` 校验两个显式根。

默认情况下，SDK 会把 LuaSkills core 固定到自身对应版本，并从兼容的 `0.1` 协议线中自动解析最新已发布的 runtime packages patch 版本。

## 版本对齐

- 尽量让 SDK 与 LuaSkills core 保持同一条当前发布版本线。
- 当前 SDK 默认指向 LuaSkills core 标签 `v0.5.7`。
- runtime packages 与 native deps 仍然来自拆分后的 `LuaSkills/luaskills-packages` 及相关发布资产。
- SDK 默认 host options 传入 `runtime_root`、两个空的受管根覆盖槽与完整稳定的 `managed_runtime_config`；宿主未显式覆盖时，LuaSkills 会推导固定数据布局。
- 宿主工具直接放在 `runtime_root/bin`，不再放到 `runtime_root/bin/tools`。

```powershell
npx @luaskills/sdk install-runtime --database vldb-direct --runtime-root D:\runtime\luaskills
npx @luaskills/sdk install-runtime --database vldb-controller --runtime-root D:\runtime\luaskills
npx @luaskills/sdk install-runtime --database host-callback --runtime-root D:\runtime\luaskills
npx @luaskills/sdk install-runtime --database none --managed-runtimes all --runtime-root D:\runtime\luaskills
```

下载前可用 `--dry-run` 检查准确的 release URL：

```powershell
npx @luaskills/sdk install-runtime --database vldb-direct --runtime-root D:\runtime\luaskills --dry-run
```

已经自行管理 Lua 包的高级宿主可以跳过 Lua runtime 归档：

```powershell
npx @luaskills/sdk install-runtime --database none --runtime-root D:\runtime\luaskills --skip-lua-runtime
```

## Skill Roots

SDK 默认 root 链是正式分层模型：

```text
ROOT    = 系统保护层
PROJECT = 项目普通层
USER    = 用户普通层
```

`RuntimeRoots.standard(runtimeRoot)` 会映射到：

```text
runtimeRoot/root_skills
runtimeRoot/project_skills
runtimeRoot/user_skills
```

面向用户的 demo 或普通安装 skill 应放入 `user_skills` 或 `project_skills`。旧式 `skills` 目录不是 SDK 标准 root 链的一部分。

## CLI 流程

基于已准备 runtime root 的 CLI 完整链路：

```powershell
$env:NODE_USE_ENV_PROXY = "1" # 仅在 Node fetch 需要使用 HTTP_PROXY/HTTPS_PROXY 时设置

npx @luaskills/sdk install-runtime --database vldb-direct --runtime-root D:\runtime\luaskills
npx @luaskills/sdk version --runtime-root D:\runtime\luaskills
npx @luaskills/sdk list --runtime-root D:\runtime\luaskills
npx @luaskills/sdk call demo-standard-ffi-skill-ping '{"note":"npx"}' --runtime-root D:\runtime\luaskills
```

如果更希望使用共享 controller 模式：

```powershell
npx @luaskills/sdk install-runtime --database vldb-controller --runtime-root D:\runtime\luaskills
npx @luaskills/sdk call demo-standard-ffi-skill-ping '{"note":"controller"}' --runtime-root D:\runtime\luaskills
```

SDK 会自动从 runtime manifest 与 `runtimeRoot/libs` 解析 `luaskills.dll` / `libluaskills.so` / `libluaskills.dylib`。

## 代码用法

基础客户端用法：

```ts
import { Authority, LuaSkillsClient, RuntimeRoots } from "@luaskills/sdk";

const runtimeRoot = "D:/runtime/luaskills";
const roots = RuntimeRoots.standard(runtimeRoot);
const client = LuaSkillsClient.create({ runtimeRoot });

try {
  client.loadFromRoots(roots);

  const entries = client.listEntries(Authority.DelegatedTool);
  const result = client.callSkill("demo-standard-ffi-skill-ping", {
    note: "typescript-sdk",
  });

  console.log(entries);
  console.log(result.content);
} finally {
  client.close();
}
```

只有在明确绕过 runtime manifest 时才需要使用 `libraryPath`：

```ts
const client = LuaSkillsClient.create({
  libraryPath: "D:/path/to/luaskills.dll",
  runtimeRoot: "D:/runtime/luaskills",
});
```

## 示例

发布包中的示例会像外部用户一样直接引用 npm 包：

```js
import { LuaSkillsClient } from "@luaskills/sdk";
```

准备好 `runtimeRoot` 后运行：

```powershell
npx @luaskills/sdk install-runtime --database none --runtime-root D:\runtime\luaskills
$env:LUASKILLS_RUNTIME_ROOT = "D:\runtime\luaskills"
node node_modules\@luaskills\sdk\examples\basic.mjs
```

源码仓库中的示例可以使用 npm scripts 运行：

```powershell
npm run example:basic
npm run example:call
npm run example:host-tool-callback
npm run example:query
npm run example:lifecycle
npm run example:runtime-lease
npm run example:runtime-lease
npm run example:provider-callback
```

query、lifecycle 与持久 runtime-lease 示例使用内置夹具 skill：`examples/fixture-runtime/user_skills/demo-standard-ffi-skill`。请先把 runtime 资产安装到该 root：

```powershell
npx @luaskills/sdk install-runtime --database none --runtime-root .\examples\fixture-runtime
```

完整示例索引与 runtime 注意事项见 [examples/README_cn.md](examples/README_cn.md)。英文示例指南见 [examples/README.md](examples/README.md)。

## 持久运行时租约

普通租约入口请使用 `client.runtimeLeases()`；如果宿主希望通过最新原生库提供的专用 system runtime-lease 导出固定注入 authority，请使用 `client.system(authority).runtimeLeases()`。

```ts
import { Authority, LuaSkillsClient } from "@luaskills/sdk";

const client = LuaSkillsClient.create({ runtimeRoot: "D:/runtime/luaskills" });

try {
  const leases = client.system(Authority.System).runtimeLeases();
  const session = leases.createHandle("demo-session", 600, true, {
    cwd: "D:/runtime/luaskills/system_lua_lib",
    mounts: { channel: "demo" },
    system_package: { id: "debug-plugin", root: "D:/runtime/luaskills/system_lua_lib/debug-plugin", dependencies_file: "dependencies.json" },
  });
  const result = session.eval("counter = (counter or 0) + 1; return { counter = counter }");
  console.log(result.result);
  console.log(session.status());
  console.log(session.close());
} finally {
  client.close();
}
```

## 迁移说明

- 现有 `client.system(authority)` 生命周期调用保持兼容；返回的 wrapper 现在额外暴露查询辅助方法和 `runtimeLeases()`。
- `RuntimeLeaseHandle` 会持久化 `lease_id + sid + generation`，并在 `eval`、`status`、`close` 时自动补回身份护栏。
- `client.system(authority).runtimeLeases()` 依赖最新原生库提供的专用 `luaskills_ffi_system_runtime_lease_*` 导出；如果这组导出缺失，会立即报错而不是静默降级。
- 当宿主在 `request_context.client_capabilities.host_result` 中显式开启结构化结果后，`callSkill()` 会返回 `host_result` 字段，结构化工具可以把 IDE 原生结果作为第四返回值带回。
- 当 `host_result.kind === "change_set"` 时，宿主应把 `payload` 按 `RuntimeChangeSetPayload` 解析。
- canonical `change_set` 现在使用文件生命周期记录；`modify` 通过 hunk 级 `before + delete[] + insert[] + after` 表达具体修改。
- `create` 与 `delete` 文件记录直接携带整文件 `content`，`rename` 记录携带 `old_path` 与 `new_path`。
- 普通租约接受 `cwd`、`workspace_root`、`lua_roots`、`c_roots`、`mounts`。System 租约强制要求 `system_package`，拒绝 `lua_roots/c_roots`，并从可信包清单推导根目录。
- `pollManagedSessionEvents()`、`waitManagedSessionEvents()`、`setManagedSessionWakeCallback()` 暴露 0.5.1 事件接口。
- 源码树示例现在会优先加载已安装发布包；拿不到时再回退到本地 `dist` 构建产物，因此仓库内烟测与独立 examples 包可以共用同一套脚本。

## JSON Provider Callback

SQLite / LanceDB 的 `host_callback + json` 模式可以在 engine 创建前通过 SDK 注册：

```ts
import { LuaSkillsClient, LuaSkillsJsonFfi } from "@luaskills/sdk";

const runtimeRoot = "D:/runtime/luaskills";
const ffi = new LuaSkillsJsonFfi({ runtimeRoot });

ffi.setSqliteProviderJsonCallback((request) => {
  return { ok: true, request };
});

try {
  const client = LuaSkillsClient.create({
    runtimeRoot,
    hostOptions: {
      sqlite_provider_mode: "host_callback",
      sqlite_callback_mode: "json",
    },
  });
  client.close();
} finally {
  ffi.clearSqliteProviderJsonCallback();
}
```

callback 必须在 `engine_new` 前注册；engine 创建后再切换 callback 不会 retroactive 影响已存在的 engine。

## 宿主工具 Callback

`vulcan.host.*` 使用通过 `luaskills_ffi_set_host_tool_json_callback` 注册的固定宿主工具 callback。请在运行可能调用宿主工具的 skill 前完成注册：

```ts
import { LuaSkillsJsonFfi, type HostToolJsonRequest } from "@luaskills/sdk";

// Runtime root used by the host integration.
// 宿主集成使用的运行时根目录。
const runtimeRoot = "D:/runtime/luaskills";
// Low-level FFI bridge that owns callback registration.
// 持有 callback 注册的底层 FFI 桥。
const ffi = new LuaSkillsJsonFfi({ runtimeRoot });

// Handle list, has, and call actions from vulcan.host.*.
// 处理来自 vulcan.host.* 的 list、has 和 call 动作。
ffi.setHostToolJsonCallback((request: HostToolJsonRequest) => {
  switch (request.action) {
    case "list":
      return [{ name: "model.embed", description: "embedding model bridge" }];
    case "has":
      return request.tool_name === "model.embed";
    case "call":
      return { ok: true, value: { request: request.args } };
    default:
      return { ok: false, error: { code: "unsupported_action", message: request.action } };
  }
});
```

callback 会收到 `{ action, tool_name, args }`。`list` 应返回宿主开放给 Lua 的工具元数据；`has` 应返回 boolean，或带有 `exists` / `has` / `available` 的对象；`call` 应返回一次完整的 table 形态结果。宿主关闭时调用 `ffi.clearHostToolJsonCallback()` 清理注册。该桥接刻意不支持 stream。

## 模型 Callback

`vulcan.models.*` 使用通过 `luaskills_ffi_set_model_embed_json_callback` 与 `luaskills_ffi_set_model_llm_json_callback` 注册的固定模型 callback。Lua skill 只能调用 `vulcan.models.embed(text)` 与 `vulcan.models.llm(system, user)`；provider 选择、模型名、密钥、temperature、thinking、限额和 stream 策略全部归宿主管理。

请在创建或使用可能运行模型类 skill 的 engine 前注册模型 callback。`LuaSkillsJsonFfi` 实例需要在 callback 生效期间保持存活；宿主关闭或测试清理时应显式清理 callback。

SDK callback 是宿主模型边界：

- 它接收 LuaSkills 发来的固定请求结构。
- 它应使用宿主选择的 provider 和宿主管理的配置发起真实模型调用。
- provider 成功时返回裸成功载荷。
- provider 失败且需要排查时返回结构化错误包络，保留 `provider_message`、`provider_code`、`provider_status`。
- 不要在 provider 错误字段里暴露 API key、Authorization header、签名或完整原始请求头。

```ts
import {
  LuaSkillsJsonFfi,
  type RuntimeModelEmbedRequest,
  type RuntimeModelLlmRequest,
} from "@luaskills/sdk";

const runtimeRoot = "D:/runtime/luaskills";
const ffi = new LuaSkillsJsonFfi({ runtimeRoot });

ffi.setModelEmbedJsonCallback((request: RuntimeModelEmbedRequest) => {
  return {
    vector: [0.1, 0.2, 0.3],
    dimensions: 3,
    usage: { input_tokens: request.text.length },
  };
});

ffi.setModelLlmJsonCallback((request: RuntimeModelLlmRequest) => {
  if (request.user.includes("missing-model")) {
    return {
      ok: false,
      error: {
        code: "provider_error",
        message: "model provider rejected the request",
        provider_message: "raw provider message after host-side redaction",
        provider_code: "model_not_found",
        provider_status: 404,
      },
    };
  }
  return {
    assistant: `handled ${request.system}: ${request.user}`,
    usage: { input_tokens: 12, output_tokens: 8 },
  };
});
```

embedding callback 会收到 `{ text, caller }`，LLM callback 会收到 `{ system, user, caller }`。成功时返回裸响应载荷；provider 失败时返回 `{ ok: false, error: { code, message, provider_message?, provider_code?, provider_status? } }`。宿主关闭时调用 `ffi.clearModelEmbedJsonCallback()` 和 `ffi.clearModelLlmJsonCallback()` 清理注册。

注册后的最小运行时检查：

```ts
const status = client.runLua("return vulcan.models.status()");
const embedResult = client.runLua('return vulcan.models.embed("hello")');
const llmResult = client.runLua('return vulcan.models.llm("system", "user")');
```

常见对接问题：

- `model_unavailable`：对应 callback 没有注册，或在 skill 调用前已经被清理。
- 缺少 provider 细节：请从 callback 返回结构化错误包络，而不是直接抛出 provider 异常。
- 缺少 FFI symbol：请确认 runtime 动态库包含 `luaskills_ffi_set_model_embed_json_callback` 与 `luaskills_ffi_set_model_llm_json_callback`。
- `caller` 字段为空：请通过已加载 runtime skill 或 runtime `runLua` 上下文调用，不要用脱离 runtime 的 provider 单元测试判断 caller context。

## 权限与管理

查询 API 默认使用 `Authority.DelegatedTool`，因此委托工具看不到 ROOT skills：

```ts
client.listEntries();
client.listSkillHelp();
client.isSkill("some-root-tool");
```

`Authority.System` 只表示宿主可以管理 ROOT；它不表示可以绕过 ROOT 所有权或同名 `skill_id` 冲突规则。

普通管理面应固定目标为 USER 或 PROJECT：

```powershell
npx @luaskills/sdk install LuaSkills/luaskills-demo-skill --target-root USER
npx @luaskills/sdk update LuaSkills/luaskills-demo-skill --target-root USER
npx @luaskills/sdk uninstall luaskills-demo-skill --target-root USER
```

system 管理面只应通过可信宿主或管理员界面开放：

```powershell
npx @luaskills/sdk system-install LuaSkills/luaskills-demo-skill --target-root ROOT --authority system
```

如果 system 命令被封装给普通 tools，宿主 wrapper 应固定传入 `--authority delegated_tool`，而不是让调用方自行选择。

## 调用面

`callSkill` 与 `runLua` 是运行时执行面，不等同于 delegated 可见性查询面。

如果产品不应该允许任意 Lua 执行，不要把 `runLua` 暴露给不可信用户。如果只允许调用部分工具，应在宿主工具 wrapper 中实现 allowlist。

## Skill Config

skill config 由每个当前有效技能包自行声明。读取或修改值之前，应先发现声明结构：

```ts
const schema = client.config.describe({ skillId: "my-skill" });
const status = client.config.validate("my-skill");

const write = client.config.set("my-skill", {
  api_key: "value",
  retry_count: 3,
});
client.config.set("my-skill", "retry_count", 4, {
  expectedRevision: write.revision,
});
client.config.get("my-skill", "api_key");
client.config.list("my-skill");
client.config.delete("my-skill", "api_key", {
  expectedRevision: write.revision,
});
client.config.refresh();
const events = client.config.pollEvents(undefined, 100);
```

必须把 `hostOptions.skill_config_root` 设置为绝对用户级目录。LuaSkills 分别把普通技能包与 ROOT 所属技能包配置保存到 `skills/config.json` 和 `system-skills/config.json`。每条原始 `list()` 记录都包含 `store_scope`，因此两个文件中同名技能包的保留记录仍可明确区分。严格版本化文档使用十进制字符串修订号、跨进程伴随锁、原子替换、缓存快照与文件监听重载；旧的无版本文档会被拒绝。

`describe()` 返回参数名、类型、约束、UI 提示、技能包作者提供的说明、枚举选项、默认值与无歧义值状态。`mode: "installed"` 不执行 Lua 即可发现所有物理技能包；默认使用有效技能包模式。人类可读字段由技能包作者自行选择一种语言，建议广泛分发的技能包使用英文，但不强制。写入仅允许当前有效技能包已声明的 key，必须同时满足声明约束与技能包校验器，并以单个技能包批次原子提交。

默认不返回配置值。`includeValues: true` 会返回未遮罩的有效值。SDK 与 LuaSkills 都不负责授权或遮罩；宿主必须对该开关和修改操作执行允许、拒绝、强制覆盖或用户授权策略。Lua 代码只能修改自身技能包，宿主 SDK 调用则有意不加跨包限制。

`expectedRevision` 用于写入与删除的比较并交换。`pollEvents`、`waitForEvents`、`watchEvents` 提供有序的本地写入和外部重载事件；只有完整处理一页后才能保存返回的 `next_sequence`。发现配置缺失时，应展示 `describe()` 结果，并要求用户或已授权 AI 工具提供声明中的参数。

JavaScript 无法区分非安全整数与整数形态的 binary64 浮点数，因此 SDK 会拒绝超出安全整数范围的 number；`1e20` 这类有限浮点值应传入十进制字符串 `"1e20"`，再由核心按已声明的 `float` 校验。

对应 CLI：

```bash
luaskills config describe my-skill --skill-config-root D:\user-config
luaskills config validate my-skill
luaskills config describe my-skill --include-values
luaskills config describe --installed --root-name ROOT
luaskills config set my-skill retry_count 3 --expected-revision 7
luaskills config set-batch my-skill '{"retry_count":4,"mode":"safe"}'
luaskills config refresh skills
luaskills config events --after-sequence 12 --limit 100
```

CLI 默认把 `--skill-config-root` 设为 `<runtime-root>/config`；嵌入 SDK 的宿主仍必须自行选择并传入绝对用户级目录。

技能包卸载后配置仍会保留，显式清理策略由宿主负责。配置只有在 Lua skill 主动读取时才会影响行为；它不是运行时强制策略层。

## 常见问题

### 安装 runtime 资产时出现 `fetch failed`

`install-runtime` 使用 Node `fetch` 下载 GitHub Release 资产。在代理环境中，PowerShell 或 curl 可能可用，但 Node fetch 仍可能因为 `ECONNRESET` 或 `UND_ERR_CONNECT_TIMEOUT` 失败。

必要时设置代理环境变量，并启用 Node 环境代理支持：

```powershell
$env:HTTP_PROXY = "http://127.0.0.1:10808"
$env:HTTPS_PROXY = "http://127.0.0.1:10808"
$env:NODE_USE_ENV_PROXY = "1"
npx @luaskills/sdk install-runtime --database vldb-direct --runtime-root D:\runtime\luaskills
```

### `LuaSkills library path is required`

这表示 SDK 找不到 LuaSkills 原生动态库。请运行 `install-runtime`、传入 `--runtime-root`，或设置 `LUASKILLS_LIB`。

```powershell
npx @luaskills/sdk install-runtime --database none --runtime-root D:\runtime\luaskills
npx @luaskills/sdk version --runtime-root D:\runtime\luaskills
```

### 运行时缺少 Lua 模块

如果 skill 运行时出现 Lua 模块加载错误，请确认运行 `install-runtime` 时没有使用 `--skip-lua-runtime`，并且 `runtimeRoot/lua_packages` 存在。SDK 默认安装 `LuaSkills/luaskills-packages` 的 `lua-runtime-packages-{platform}.tar.gz`，正是为了解决这个运行期依赖问题。

```powershell
npx @luaskills/sdk install-runtime --database none --runtime-root D:\runtime\luaskills
Test-Path D:\runtime\luaskills\lua_packages
```

### 复制 demo skill 后 `list` 为空

请检查目录。SDK 标准 root 是 `root_skills`、`project_skills`、`user_skills`；把 skill 放到 `runtimeRoot/skills` 不会通过标准链加载。

```text
D:\runtime\luaskills\user_skills\demo-standard-ffi-skill\skill.yaml
```

### Windows 本地 shim 的 JSON 解析错误

在 PowerShell 中直接调用本地 npm `.cmd` shim 时，单引号 JSON 可能被不同方式转发，并触发 `Expected property name or '}' in JSON`。本地烟测建议优先使用 `npx`、`.ps1` shim 或 JS 脚本。

```powershell
.\node_modules\.bin\luaskills.ps1 call demo-standard-ffi-skill-ping '{"note":"powershell"}' --runtime-root D:\runtime\luaskills
```

### `vldb-controller` 测试后仍保留进程

托管 controller 模式可能会按 lease/idle timeout 保留 controller 进程。测试清理时只应停止测试 `runtimeRoot/bin` 下的 controller 可执行文件。

## JSON FFI 覆盖范围

SDK 覆盖公共 JSON FFI 主要入口：

- version / describe
- engine_new / engine_free
- load_from_roots / reload_from_roots
- list_entries / list_skill_help / render_skill_help_detail
- prompt_argument_completions / is_skill / skill_name_for_tool
- call_skill / run_lua
- skill_config list / describe / validate / get / 批量 set / CAS delete / refresh / 事件轮询
- SQLite / LanceDB JSON provider callback register / clear
- 宿主工具 JSON callback register / clear
- 模型 embed / LLM JSON callback register / clear
- disable / enable / install / update / uninstall
- system_disable / system_enable / system_install / system_update / system_uninstall

## 发布

发布版本记录在 `VERSION`。发布前请保持 `VERSION`、`package.json` 与 `package-lock.json` 一致。

如果要做生态统一发布，必须先发布 `LuaSkills/luaskills-packages`，再发布 `LuaSkills/luaskills`，确保本 SDK 默认安装器引用的 runtime 资产已经存在。

发布前执行：

```bash
npm install
npm run check
npm run build
npm pack --dry-run
```

包暴露：

- `main`: `dist/index.js`
- `types`: `dist/index.d.ts`
- `bin`: `dist/cli.js`

每次 npm publish 都必须使用新的 patch 版本；已发布版本不能覆盖。

推荐统一发布顺序：`luaskills-packages` -> `luaskills` 核心仓库 -> TypeScript SDK -> Python SDK -> Go SDK -> 各 SDK 的 examples release。

npm 发布成功后，手动运行 GitHub Actions 里的 **Examples Release** 工作流。它会读取 `VERSION`，从 npm 安装 `@luaskills/sdk@{VERSION}`，安装 LuaSkills runtime 资产，运行示例冒烟测试，然后创建或更新 `examples-v{VERSION}` GitHub Release，并上传：

- `luaskills-sdk-typescript-examples-{VERSION}.zip`
- `luaskills-sdk-typescript-examples-{VERSION}.zip.sha256`

示例 release tag 故意使用 `examples-v` 前缀，因为它是示例资产发布，不是 SDK 包版本。
