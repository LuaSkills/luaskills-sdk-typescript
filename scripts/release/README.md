# TypeScript SDK 正式发布及双链恢复

本目录拥有 SDK 身份、一次实际 npm 打包、五平台安装消费及正式发布证明。核心平台、归档、描述、工具链和路径解析来自固定核心检出的 `sdk_prerequisites.py`、`SDK_PREREQUISITES.md`。精确 Actions 轮次、制品读取及签名清单来自同一检出的 `sdk_recovery.py`、`SDK_RECOVERY.md`。SDK 不复制这些公共定义。

工作流必须先进入默认分支。dispatch 的 `sdk_source_sha` 必须同时等于实际 SDK HEAD、github.sha 和 workflow SHA；禁止旧 tag 工作流搭配新源码。package.json 是唯一 SDK 版本来源，VERSION 和 lock 镜像必须一致。core_tag/core_commit 独立显式指定，源码及 tgz 内默认核心标签必须匹配前置门禁。此源码面向零点六发布线，包版本、lock、VERSION 与默认核心标签统一为 0.6.1／v0.6.1；发布及资产验收遵循既有流程，正式门禁仍要求匹配经过验收的精确核心身份。

## 原候选先于任何变更

工作流 mode 为 artifact-only（默认）、publish、recover。前两者执行 prepare、五平台实际 installed-tgz native gate 和 aggregate；只构建一个 tgz。每个平台使用相同 tgz 和公共 helper 的精确库、真实描述及身份，不允许 skip。现有门禁继续固定 lock 的 Koffi 来源，并执行真实 embedded client、回调、scope close 和整数策略。

candidate-evidence 在全部门禁成功后、任何 npm/GitHub Release 变更前冻结并由固定 SHA 的官方 actions/attest 签名：

- 唯一 tgz、sdk-artifact.json、sdk-aggregate.json。
- 每个核心平台的原生报告及原始 stdout/stderr，包括空 stderr。
- 完整原 sdk-core-prerequisites.tar.gz。
- schema2 sdk-candidate-manifest.json、原字节 sdk-candidate-bundle.tar.gz。
- 独立直接签名的公共 recovery-binding.json；随后保存 sdk-candidate-attestation.jsonl。

完整签名制品上传为公共名称算法产生的 candidate-evidence-rRUNID-aATTEMPT，实际 artifact ID 来自上传输出。绑定清单排除自身及随后生成的官方 bundle，避免循环。内部 seal 认证已完成 prepare/native/aggregate、全部签名及实际日志，不声称当前证据作业已成功。

默认 artifact-only 仅保存已测证据，不得写 registry 或公共 Release。候选签名任务拥有 contents read 与签名所需 id-token/attestations write；实际发布任务受 production environment 保护，独立拥有 contents/id-token/attestations write。原模式保持原样；当前明确 publish/recover 可消费原 artifact-only 候选，候选本身不授予发布权限。

## 显式恢复与完成

正常 publish 使用当前 candidate-evidence 的实际 ID。recover 必须输入原 candidate_run_id/candidate_run_attempt/candidate_artifact_id，不查询 latest、不扫描替代制品、不重建原 gzip/ZIP。认证顺序为公共 exact-attempt → exact-artifact 字节 → 官方 gh 验签 → 公共 signed binding → 完整物理清单 → 实际 tgz、完整核心、五平台报告及原日志。缺失、过期、未知状态、缺门禁或字节差异在变更前失败。

原整轮可以实际失败，或在同一工作流发布时保持 in_progress/null；原 prepare/native/aggregate/candidate-evidence 必须逐一 completed/success，官方证书与签名调用必须绑定指定原 attempt。保留实际整体状态，不能改写为成功。新 completion 初版源码必须严格等于原 SDK SHA，同时记录独立 completion_source_sha。

需要公共 complete/recheck 的每个新执行器先 fresh github-only → 公共 toolchain-inputs → 安装输出的 actual release toolchain → complete/recheck（含真实 registry consumer）。宿主键从公共矩阵当前 runner 的唯一记录派生，不复制 Rust 版本、MSRV 推算或平台清单。纯 native/formal-proof 不执行 Cargo、不安装 Rust。

唯一 publish-or-verify 重新认证原候选、当前意图、源码/version/lock、完整矩阵、GitHub token 写权限及默认树/真实 tag。冷下载官方 npm 精确版本：仅同已测 SHA 才复用；仅精确版本端点 404 才执行一次 npm publish 原 tgz。tarball 404、不同字节、权限/服务未知错误均失败。成功或明确版本竞争后仍需重新下载核对，不能吞任意发布错误。[npm 官方可信发布](https://docs.npmjs.com/trusted-publishers/)

随后新目录、新空缓存、空 npmrc、官方 registry 安装准确版本，核对 lock resolved/integrity、实际成员字节并执行包内原生门禁。主 vVERSION Release 只包含完整原 signed candidate：认证完整分页精确 tag/actual ID → draft → 全资产字节复核 → publish。同字节复用、不同拒绝；部分草稿只补原清单缺项；未知旧资产、已公开缺项或真实 tag SHA 不同均拒绝，不 overwrite/delete/clobber。仅初始 exact Git ref 404 代表缺失，嵌套 annotation 404 属于身份未知。服务器 immutable 仅记录，不修改或假定启用。

新 completion 冻结 fresh core/recheck、冷 npm consumer、fresh aggregate、actual main Release ID/tag/source、相同原 package inventory、原 manifest/bundle/attestation/binding 四摘要及 actual candidate observation。官方签名全部主体，发布到独立 recovery-vVERSION-rCOMPLETION_RUN-aCOMPLETION_ATTEMPT。主 Release 绝不追加新证明；completion 失败后的新 attempt 使用新完成链，原候选与主草稿字节不变。公开已成功但回读丢失时，后续从 actual ID/source/全字节复用，不重传或重编辑最终 Release。

## 唯一正式消费接口

需要 Python ≥3.11。workflow 用 Python 3.12、Node 24，并实测 Node ≥22.14.0、npm ≥11.5.1。调用者必须检出准确 SDK SHA 和独立固定核心 SHA。输出独占创建，不能覆盖证明。

```text
python scripts/release/sdk_release.py formal-proof --core-root FROZEN_CORE_CHECKOUT --repository LuaSkills/luaskills-sdk-typescript --sdk-source-sha ORIGINAL_SDK_SHA --sdk-version EXACT_VERSION --candidate-run-id ORIGINAL_RUN --candidate-run-attempt ORIGINAL_ATTEMPT --completion-run-id COMPLETION_RUN --completion-run-attempt COMPLETION_ATTEMPT --completion-source-sha COMPLETION_SHA --output NEW_DIRECTORY
```

没有含混 --run-id 或单链 fallback。helper 从准确 completion Release 先下载固定 manifest/官方 bundle，实际 gh 验签后才读取清单；再核对全部 subjects。指定 completion 整体及 publish job 必须 completed/success；签发任务不认证自己尚未完成的整体成功。原候选长期字节从 actual main Release 读取，不依赖已过期 Actions artifact；原 exact-attempt 成功门禁仍须认证。

原/新官方证书必须匹配 source、signer workflow、source ref、hosted runner、runInvocationURI 及 signed statement invocationId。验证全部原包、核心、native/raw logs、completion fresh aggregate、四摘要引用和 actual main Release，再执行本次 fresh npm native 消费。[官方 gh 签名证书语义](https://cli.github.com/manual/gh_attestation_verify)

成功 accepted.json 顶部合同固定为：

```json
{
  "schema_version": 2,
  "sdk_source_sha": "完整原SDK SHA",
  "sdk_version": "精确版本",
  "core_tag": "独立核心标签",
  "core_commit": "完整核心SHA",
  "candidate_run_id": "运行ID字符串",
  "candidate_run_attempt": 2,
  "completion_run_id": "完成运行ID字符串",
  "completion_run_attempt": 3,
  "completion_source_sha": "独立完成SHA，初版等于原SDK SHA",
  "repository": "LuaSkills/luaskills-sdk-typescript",
  "accepted": true,
  "registry_consumer_file": "formal-consumer.json",
  "registry_consumer_sha256": "本次文件实际SHA256"
}
```

原 issuer consumer 在 completion 子目录，本次 formal-consumer.json 独立生成。失败不生成 accepted。后续 SDK 只调用本 helper 并读取此头，不复制 SDK 资产协议或以自填成功 JSON 替代签名。

分阶段 CLI 提供 freeze/artifact/matrix/native/aggregate、candidate-bundle/candidate-seal/candidate-fetch、publish-or-verify/registry-consumer/publish-candidate/completion-bundle/publish-completion。每个子命令 --help 给出全部必需路径与身份。构建原候选不接受 recover，发布只接受 publish/recover 当前意图。

## 六例源码 ZIP

唯一已审核六例清单控制真实 ZIP 的全部源文件、支持 fixture、生成说明、package 元数据和文档链接验证；npm embedded 开发例不进入 standalone。ZIP 固定顺序、时间、权限、换行和 stored 字节，改变 mtime/权限或重新 staging 后仍逐字节相同。

examples workflow 接受正式 SDK 明确两链身份，fresh npm native 通过后安装准确 SDK/runtime、真实运行六例。examples-bundle 一次冻结 ZIP/sidecar/notes/actual smoke log/SDK accepted+consumer，官方签名原制品先保存；当前明确 publish/recover 才认证恢复并执行另一次 fresh 同 SDK 身份消费。ZIP/sidecar 不重建，按相同 draft 规则发布独立 examples-vVERSION，不追加 SDK 主 Release。这是固定源码包；首次须联网 npm install 和 npm run install-runtime，不含 node_modules 或机器 runtime，不宣称离线完整运行包。

## 验证与未执行边界

```text
python tests/sdk-release-gate.py --core-root CORE_SOURCE_CHECKOUT --archive ACTUAL_LOCALLY_PACKED_TGZ -v
python tests/standalone-examples-package.py -v
```

离线 tests 使用真实 tgz、真实 ZIP 与公共恢复函数。明确合成的 HTTP/官方进程输出仅检查协议和失败行为，不是实际加密、registry 或五平台证明。覆盖原整轮失败/运行中、准确旧 attempt、缺/过期制品、缺门禁、签名/字节变化、两链 accepted、缺 fresh consumer、跨 attempt 完成重试、部分草稿、公开丢回读和实际六例可重复 ZIP。

本轮未运行正式五平台 workflow、核心正式 registry 消费、npm OIDC 发布、公共 Release 上传或远端 recovery。维护者仍须配置 npm Trusted Publisher 精确绑定仓库/sdk-release.yml/production，以及 GitHub production environment/tag rules；已有只读信息未确认这些账户设置，不能宣称 CI 成功。不使用 PAT、备用账户或管理员修改 immutable 设置。
