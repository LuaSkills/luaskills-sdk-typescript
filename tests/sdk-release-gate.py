"""Exercise real npm archive bytes and release-gate failures without publication or Cargo.
使用真实 npm 归档字节验证发布门禁失败分支，不发布也不运行 Cargo。
"""

import argparse
import copy
import contextlib
import importlib.util
import io
import json
import os
import hashlib
import zipfile
import tarfile
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

# Keep the explicit test inputs separate from release CLI; mocks exist only in this test module.
# 将显式测试输入与发布 CLI 分离；替身仅存在于本测试模块。
PARSER = argparse.ArgumentParser()
PARSER.add_argument("--core-root", required=True)
PARSER.add_argument("--archive", required=True)
OPTIONS, TEST_ARGUMENTS = PARSER.parse_known_args()
# Import this SDK's real gate and the core's sole platform authority.
# 导入本 SDK 真实门禁与核心唯一平台权威。
ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("sdk_release", ROOT / "scripts/release/sdk_release.py")
RELEASE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RELEASE)
CORE = RELEASE.authority(OPTIONS.core_root)
RECOVERY, SHARED = RELEASE.recovery_authority(OPTIONS.core_root)


class RecoveryHttp:
    """Serve exact documented read-only attempts and actual ZIP fixtures; reject every undefined URL.
    提供精确文档只读轮次及实际 ZIP 夹具；拒绝每个未定义 URL。
    """

    def __init__(self, responses):
        """Store explicit URL responses and initialize a call trace; return the offline fixture.
        保存明确 URL 响应并初始化调用轨迹；返回离线夹具。
        """
        self.responses = responses
        self.calls = []

    def json(self, url):
        """Return a detached exact JSON fixture for URL or propagate its explicit missing state.
        返回 URL 对应独立精确 JSON 夹具，或传播明确缺失状态。
        """
        self.calls.append(url)
        if url not in self.responses:
            raise ValueError("Offline HTTP 404: " + url)
        return copy.deepcopy(self.responses[url])

    def get(self, url, binary=False):
        """Return real binary fixture bytes and empty headers; require the documented binary flag.
        返回真实二进制夹具字节及空头部；要求文档二进制标志。
        """
        self.calls.append(url)
        if url not in self.responses:
            raise ValueError("Offline HTTP 404: " + url)
        if not binary:
            raise AssertionError("Recovery binary URL must request binary bytes")
        return self.responses[url], {}


class ReleaseGateTests(unittest.TestCase):
    """Check identity, aggregation, issuer authentication and immutable assets using unit-only fixtures.
    使用仅限单测的夹具检查身份、聚合、签发方认证和不可变资产。
    """

    def setUp(self):
        """Copy the actual tgz and create distinctly synthetic evidence for each isolated test.
        复制实际 tgz，并为每个隔离测试创建明确合成的证据。
        """
        self.temporary = tempfile.TemporaryDirectory(prefix="luaskills-release-test-")
        self.root = Path(self.temporary.name)
        (self.root / "original").mkdir()
        self.archive = self.root / "original" / Path(OPTIONS.archive).name
        self.archive.write_bytes(Path(OPTIONS.archive).read_bytes())
        self.core_tag = RELEASE.default_tag(RELEASE.archive_files(self.archive)["src/runtime-assets.ts"].decode())
        self.core_version = self.core_tag.removeprefix("v")
        self.identity = {"schema_version": RELEASE.SDK_SCHEMA, "sdk_source_sha": "a" * 40,
            "workflow_source_sha": "a" * 40, "sdk_version": RELEASE.versions(ROOT), "core_tag": self.core_tag,
            "core_commit": "b" * 40, "lock_sha256": RELEASE.digest(ROOT / "package-lock.json"),
            "archive": self.archive.name, "tgz_sha256": RELEASE.digest(self.archive)}
        self.artifact = self.root / "original" / RELEASE.RELEASE_FILES["artifact"]
        RELEASE.write_json(self.artifact, self.identity)
        self.prerequisites = self.root / "prerequisites.json"
        self.core_input = {name: {"schema_version": CORE.MANIFEST_VERSION, "platform": name,
            "core_version": self.core_version, "source_commit": "b" * 40, "library": "/unit-only/library",
            "description": "/unit-only/description", "library_sha256": "c" * 64,
            "description_sha256": "d" * 64, "archive_sha256": "e" * 64,
            "build": {"contract_sha256": "f" * 64, "inputs_sha256": "9" * 64}}
            for name in CORE.PLATFORMS}
        self.document = {"schema_version": CORE.MANIFEST_VERSION, "phase": "complete", "complete": True,
            "core_tag": self.core_tag, "core_version": self.core_version, "core_commit": "b" * 40,
            "registry": {"name": "luaskills", "version": self.core_version, "vcs_commit": "b" * 40,
                "consumer": {"commands": [{"command": ["unit-only-command"], "exit_code": 0,
                    "stdout_sha256": "1" * 64, "stderr_sha256": "2" * 64} for _ in range(4)],
                    "executable": "/unit-only/executable", "executable_sha256": "3" * 64,
                    "cargo_lock_sha256": "4" * 64, "package_id": "unit-only", "source": "unit-only",
                    "result": {"challenge": "5" * 64, "runtime": True, "pool_reuse": True,
                               "capability_calls": 2, "drained": True}}}, "sdk_inputs": self.core_input}
        RELEASE.write_json(self.prerequisites, self.document)
        self.descriptions = self.root / "descriptions"
        self.descriptions.mkdir()
        for name in CORE.PLATFORMS:
            RELEASE.write_json(self.descriptions / (name + ".json"), {"core_version": self.core_version,
                "protocol_version": 1, "build": self.core_input[name]["build"]})
        self.evidence = self.root / "native-evidence"
        self.evidence.mkdir()
        self.records = {name: {"schema_version": RELEASE.SDK_SCHEMA, "platform": name, "artifact": copy.deepcopy(self.identity),
            "core_input": {k: v for k, v in value.items() if k not in ("library", "description")},
            "test": {"core_version": self.core_version, "protocol_version": 1, "contract_sha256": "f" * 64,
                     "callback_count": 2, "scope": "closed"}, "success": True, "skipped": False}
            for name, value in self.core_input.items()}
        for name, record in self.records.items():
            RELEASE.write_json(self.evidence / (name + ".json"), record)
        self.args = SimpleNamespace(core_root=OPTIONS.core_root, artifact=self.artifact, prerequisites=self.prerequisites,
                                    evidence_dir=self.evidence, output=self.root / "aggregate.json")

    def tearDown(self):
        """Remove only this test's unique temporary directory; return nothing.
        仅删除本测试唯一临时目录；无返回值。
        """
        self.temporary.cleanup()

    def aggregate(self):
        """Run actual strict aggregation with only source checkout validation replaced for unit fixtures.
        仅替换单测夹具的源码检出验证，运行实际严格聚合。
        """
        with patch.object(RELEASE, "authority", return_value=CORE), patch.object(RELEASE, "shared_gate", return_value=self.shared_fixture()):
            RELEASE.aggregate(self.args)

    def shared_fixture(self):
        """Return a unit-only resolver exposing explicit on-disk description fixture bytes.
        返回仅限单测的解析器，提供显式磁盘描述夹具字节。
        """
        def resolve(prerequisites, name):
            """Return the exact selected fixture input; never resolve candidate files in production.
            返回精确选定的夹具输入；绝不解析生产候选文件。
            """
            return {**self.core_input[name], "description": str(self.descriptions / (name + ".json"))}

        return SimpleNamespace(resolve_sdk_inputs=resolve)

    def publication_args(self):
        """Create actual aggregation of unit-only native records; return the exact publication arguments.
        对仅限单测的原生记录执行实际聚合；返回精确发布参数。
        """
        self.aggregate()
        return SimpleNamespace(**vars(self.args), aggregate=self.args.output, repository="test/repo", candidate=self.root, intent="publish")

    def publication_context(self, metadata, content, completed):
        """Replace only external source/API/process boundaries while preserving archive and matrix validation.
        仅替换外部源码、API、进程边界，保留归档及矩阵实际验证。
        """
        stack = contextlib.ExitStack()
        stack.enter_context(patch.object(RELEASE, "authority", return_value=CORE))
        stack.enter_context(patch.object(RELEASE, "shared_gate", return_value=self.shared_fixture()))
        stack.enter_context(patch.object(RELEASE, "local_candidate", return_value={"root": self.root, "identity": self.identity}))
        stack.enter_context(patch.object(RELEASE, "current_completion"))
        stack.enter_context(patch.object(RELEASE, "run", side_effect=lambda command: self.identity["sdk_source_sha"] if command[1:3] == ["rev-parse", "HEAD"] else ""))
        stack.enter_context(patch.object(RELEASE, "publication_preflight"))
        stack.enter_context(patch.object(RELEASE, "tools"))
        stack.enter_context(patch.object(RELEASE, "request_json", side_effect=metadata))
        stack.enter_context(patch.object(RELEASE.urllib.request, "urlopen", side_effect=content))
        stack.enter_context(patch.object(RELEASE.shutil, "which", return_value="unit-only-npm"))
        command = stack.enter_context(patch.object(RELEASE.subprocess, "run", return_value=completed))
        return stack, command

    def npm_metadata(self):
        """Return a clearly unit-only official metadata shape for the actual archive version.
        为实际归档版本返回明确仅限单测的官方元数据形状。
        """
        return {"name": "@luaskills/sdk", "version": self.identity["sdk_version"],
                "dist": {"tarball": "https://registry.npmjs.org/@luaskills/sdk/-/sdk.tgz"}}

    def missing_npm_version(self, code=404):
        """Return the requested HTTP error for this exact npm version endpoint, never its tarball.
        返回此精确 npm 版本端点请求的 HTTP 错误，绝不代表 tarball。
        """
        error = RELEASE.urllib.error.HTTPError("https://registry.npmjs.org/@luaskills%2fsdk/" + self.identity["sdk_version"],
                                               code, "unit-only registry error", {}, None)
        self.addCleanup(error.close)
        return error

    def alter_record(self, change):
        """Apply a requested mutation to one existing platform record and persist its bytes.
        对一个已有平台记录应用请求变更并保存字节。
        """
        name = next(iter(self.records))
        record = copy.deepcopy(self.records[name])
        change(record)
        (self.evidence / (name + ".json")).write_text(json.dumps(record), encoding="utf-8")



    def test_actual_tgz_contract_and_defaults(self):
        """Check real archive members, authoritative version and source/compiled default tag agree.
        检查真实归档成员、权威版本与源码、编译默认标签一致。
        """
        files = RELEASE.archive_files(self.archive)
        self.assertEqual(json.loads(files["package.json"])["version"], RELEASE.versions(ROOT))
        self.assertEqual(files["VERSION"].decode().strip(), RELEASE.versions(ROOT))
        self.assertEqual(RELEASE.default_tag(files["src/runtime-assets.ts"].decode()),
                         RELEASE.default_tag(files["dist/runtime-assets.js"].decode()))
        self.assertIn("examples/embedded-candidate.mjs", files)
        RELEASE.validate_artifact(self.identity, self.archive)

    def test_real_distribution_verifier_and_artifact_identity(self):
        """Run the real archive/codec verifier while source-state substitution stays unit-only.
        运行真实归档、编码器验证器；源码状态替换仍仅限单测。
        """
        files = RELEASE.archive_files(self.archive)
        frozen = {k: v for k, v in self.identity.items() if k not in ("archive", "tgz_sha256")}
        frozen["core_tag"] = RELEASE.default_tag(files["src/runtime-assets.ts"].decode())
        freeze_file = self.root / "freeze.json"
        RELEASE.write_json(freeze_file, frozen)
        args = SimpleNamespace(freeze=freeze_file, archive=self.archive, output=self.root / "real-artifact.json")
        original = RELEASE.run

        def command(arguments, *extra, **keywords):
            """Keep the real Node verifier and substitute only synthetic git fixture identity.
            保持真实 Node 验证器，仅替换合成 Git 夹具身份。
            """
            if arguments[:2] == ["git", "rev-parse"]:
                return frozen["sdk_source_sha"]
            if arguments[:2] == ["git", "status"]:
                return ""
            return original(arguments, *extra, **keywords)

        with patch.object(RELEASE, "run", side_effect=command):
            RELEASE.artifact(args)
        record = RELEASE.read_json(args.output)
        self.assertEqual(record["tgz_sha256"], RELEASE.digest(self.archive))
        self.assertEqual(record["core_tag"], frozen["core_tag"])

    def test_version_lock_mirrors_fail(self):
        """Reject an actual changed VERSION or lock root mirror in an isolated source fixture.
        在隔离源码夹具中拒绝实际改变的 VERSION 或锁根镜像。
        """
        for name in ("package.json", "package-lock.json", "VERSION"):
            (self.root / name).write_bytes((ROOT / name).read_bytes())
        self.assertEqual(RELEASE.versions(self.root), RELEASE.versions(ROOT))
        (self.root / "VERSION").write_text("0.0.0", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "VERSION mismatch"):
            RELEASE.versions(self.root)
        (self.root / "VERSION").write_bytes((ROOT / "VERSION").read_bytes())
        lock = RELEASE.read_json(self.root / "package-lock.json")
        lock["packages"][""]["version"] = "0.0.0"
        (self.root / "package-lock.json").write_text(json.dumps(lock), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "Lock version mismatch"):
            RELEASE.versions(self.root)




    def test_strict_complete_platform_aggregation(self):
        """Accept all authority-derived fixture platforms and bind the actual tgz hash.
        接受全部权威派生夹具平台并绑定实际 tgz 摘要。
        """
        self.aggregate()
        result = RELEASE.read_json(self.args.output)
        self.assertEqual(set(result["platforms"]), set(CORE.PLATFORMS))
        self.assertEqual(result["artifact"]["tgz_sha256"], RELEASE.digest(self.archive))
        self.assertIs(result["complete"], True)

    def test_missing_platform_fails_without_success_evidence(self):
        """Missing one required native platform must fail before writing aggregate proof.
        缺失一个必需原生平台时，必须在写入聚合证明前失败。
        """
        next(self.evidence.iterdir()).unlink()
        with self.assertRaisesRegex(ValueError, "Missing native platform"):
            self.aggregate()
        self.assertFalse(self.args.output.exists())

    def test_duplicate_platform_fails(self):
        """Reject two records claiming the same actual platform identity.
        拒绝两个记录声明同一实际平台身份。
        """
        RELEASE.write_json(self.evidence / "duplicate.json", next(iter(self.records.values())))
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            self.aggregate()

    def test_tampered_sdk_core_schema_and_test_evidence_fail(self):
        """Reject identity drift, skipped/error results, unsupported schema and incomplete native work.
        拒绝身份漂移、跳过、错误结果、不支持的结构版本与未完成原生操作。
        """
        changes = [lambda r: r["artifact"].update(tgz_sha256="0" * 64),
                   lambda r: r["artifact"].update(sdk_source_sha="0" * 40),
                   lambda r: r["core_input"].update(library_sha256="0" * 64),
                   lambda r: r.update(schema_version=999), lambda r: r.update(schema_version=True),
                   lambda r: r.update(skipped=True), lambda r: r.update(success=False),
                   lambda r: r["test"].update(callback_count=0), lambda r: r["test"].update(scope="open"),
                   lambda r: r["test"].update(protocol_version=2), lambda r: r.update(extra=True)]
        for change in changes:
            with self.subTest(change=change):
                for name, record in self.records.items():
                    (self.evidence / (name + ".json")).write_text(json.dumps(record), encoding="utf-8")
                self.alter_record(change)
                with self.assertRaises((ValueError, KeyError)):
                    self.aggregate()
                self.assertFalse(self.args.output.exists())

    def test_all_platform_protocol_mutation_rejected_by_actual_description(self):
        """Even unanimous protocol tampering must disagree with verified description bytes and fail.
        即使全部平台一致篡改协议，也必须因与已验证描述字节不一致而失败。
        """
        for name, record in self.records.items():
            changed = copy.deepcopy(record)
            changed["test"]["protocol_version"] = 2
            (self.evidence / (name + ".json")).write_text(json.dumps(changed), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "actual core description"):
            self.aggregate()
        self.assertFalse(self.args.output.exists())

    def test_changed_actual_archive_fails(self):
        """An appended byte changes the actual archive digest and must fail before aggregation.
        追加字节改变实际归档摘要，必须在聚合前失败。
        """
        with self.archive.open("ab") as stream:
            stream.write(b"changed")
        with self.assertRaisesRegex(ValueError, "Artifact bytes changed"):
            self.aggregate()

    def test_github_only_and_missing_registry_consumer_fail(self):
        """A GitHub-only flag or erased/failed real registry consumer cannot authorize release.
        仅 GitHub 标志或被删除、失败的真实 registry 消费者不能授权发布。
        """
        changes = [lambda d: d.update(phase="github-only", complete=False, registry=None),
                   lambda d: d.update(registry={}), lambda d: d["registry"]["consumer"].update(commands=[]),
                   lambda d: d["registry"]["consumer"]["commands"][0].update(exit_code=1),
                   lambda d: d["registry"]["consumer"]["result"].update(drained=False)]
        for change in changes:
            with self.subTest(change=change):
                document = copy.deepcopy(self.document)
                change(document)
                self.prerequisites.write_text(json.dumps(document), encoding="utf-8")
                with self.assertRaises((ValueError, KeyError)):
                    self.aggregate()

    def test_duplicate_json_keys_and_unsafe_tar_members_fail(self):
        """Reject duplicate identity keys and archive links or traversal before file materialization.
        在文件落盘前拒绝重复身份键与归档链接、路径穿越。
        """
        duplicate = self.root / "duplicate.json"
        duplicate.write_text('{"schema_version":1,"schema_version":2}', encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "Duplicate JSON"):
            RELEASE.read_json(duplicate)
        for name, kind in (("package/../escape", tarfile.REGTYPE), ("package/link", tarfile.SYMTYPE),
                           ("package//escape", tarfile.REGTYPE), ("package/./escape", tarfile.REGTYPE),
                           ("package/a//escape", tarfile.REGTYPE), ("package/C:/escape", tarfile.REGTYPE)):
            unsafe = self.root / "unsafe.tgz"
            with tarfile.open(unsafe, "w:gz") as bundle:
                entry = tarfile.TarInfo(name)
                entry.type = kind
                entry.size = 1 if kind == tarfile.REGTYPE else 0
                bundle.addfile(entry, io.BytesIO(b"x") if entry.size else None)
            with self.assertRaisesRegex(ValueError, "Unsafe|Non-regular"):
                RELEASE.archive_files(unsafe)

    def test_native_child_error_never_emits_success(self):
        """Propagate a real child error boundary without replacing it with caller-provided success.
        传播真实子进程错误边界，不以调用者成功文字替代。
        """
        args = SimpleNamespace(core_root=OPTIONS.core_root, artifact=self.artifact, prerequisites=self.prerequisites,
                               platform=next(iter(CORE.PLATFORMS)), output=self.root / "native.json")
        decoded = {"core_version": self.core_version, "protocol_version": 1, "build": {"contract_sha256": "f" * 64}}
        with patch.object(RELEASE, "run", side_effect=[self.identity["sdk_source_sha"], ValueError("actual child failed")]), \
             patch.object(RELEASE, "native_inputs", return_value=(next(iter(self.core_input.values())), self.archive, self.archive, decoded)):
            with self.assertRaisesRegex(ValueError, "actual child failed"):
                RELEASE.native(args)
        self.assertFalse(args.output.exists())

    def test_native_output_is_exact_and_never_skip(self):
        """Require one full native callback/close JSON result instead of success-looking text.
        要求一个完整原生回调、关闭 JSON 结果，不能使用看似成功的文字。
        """
        decoded = {"core_version": self.core_version, "protocol_version": 1, "build": {"contract_sha256": "f" * 64}}
        result = next(iter(self.records.values()))["test"]
        self.assertEqual(RELEASE.parse_native(json.dumps(result) + "\nGate verified", decoded), result)
        for stdout in ("skipped", "Gate verified", json.dumps(result) + "\n" + json.dumps(result),
                       json.dumps({**result, "callback_count": 0}), json.dumps({**result, "scope": "open"})):
            with self.subTest(stdout=stdout), self.assertRaises(ValueError):
                RELEASE.parse_native(stdout, decoded)

    def test_source_workflow_version_and_default_tag_failures(self):
        """Fail frozen source/workflow drift and actual mismatched SDK/core default tags.
        冻结源码、工作流漂移及实际 SDK、核心默认标签不一致时失败。
        """
        args = SimpleNamespace(core_root=OPTIONS.core_root, core_tag="v999.0.0", core_commit="b" * 40,
                               sdk_source_sha="a" * 40, workflow_source_sha="a" * 40, output=self.root / "freeze.json")
        with patch.object(RELEASE, "run", side_effect=["a" * 40, ""]), patch.object(RELEASE, "authority", return_value=CORE):
            with self.assertRaisesRegex(ValueError, "Default core asset tag"):
                RELEASE.freeze(args)
        args.workflow_source_sha = "c" * 40
        with self.assertRaisesRegex(ValueError, "Workflow source"):
            RELEASE.freeze(args)
        self.assertFalse(args.output.exists())

    def test_same_asset_reused_different_asset_rejected_before_upload(self):
        """Reuse identical assets and reject any conflicting member before an upload mutation.
        复用相同资产，并在上传变更前拒绝任一冲突成员。
        """
        asset = self.root / "asset.zip"
        asset.write_bytes(b"same")
        release = {"id": 1, "draft": False, "prerelease": False, "immutable": False}
        entries = {"asset.zip": {"id": 2}}
        with patch.object(RELEASE, "release_by_tag", return_value=release), patch.object(RELEASE, "github_request", return_value=b"same"), \
             patch.object(RELEASE, "resolve_sdk_tag"), patch.object(RELEASE, "release_assets", return_value=entries), \
             patch.object(RELEASE, "run") as command:
            RELEASE.immutable_upload("test/repo", "v0.5.7", "a" * 40, [asset], "title", asset)
            command.assert_not_called()
        missing = self.root / "missing.zip"
        missing.write_bytes(b"new")
        with patch.object(RELEASE, "release_by_tag", return_value=release), patch.object(RELEASE, "github_request", return_value=b"different"), \
             patch.object(RELEASE, "resolve_sdk_tag"), patch.object(RELEASE, "release_assets", return_value=entries), \
             patch.object(RELEASE, "run") as command:
            with self.assertRaisesRegex(ValueError, "Existing asset differs"):
                RELEASE.immutable_upload("test/repo", "v0.5.7", "a" * 40, [missing, asset], "title", asset)
            command.assert_not_called()

    def test_final_release_never_appended(self):
        """Reject missing final-release assets before mutation, even when server immutability is off.
        即使服务器未启用不可变设置，也在变更前拒绝正式发布缺失资产。
        """
        release = {"id": 1, "draft": False, "prerelease": False, "immutable": False}
        with patch.object(RELEASE, "release_by_tag", return_value=release), patch.object(RELEASE, "resolve_sdk_tag"), \
             patch.object(RELEASE, "release_assets", return_value={}), patch.object(RELEASE, "run") as command:
            with self.assertRaisesRegex(ValueError, "final releases are never appended"):
                RELEASE.immutable_upload("test/repo", "v0.5.7", "a" * 40, [self.archive], "title", self.archive)
            command.assert_not_called()

    def test_draft_all_assets_verified_before_publish(self):
        """Upload only a missing draft asset and publish only after rechecking all actual bytes.
        仅上传缺失草稿资产，在复核全部实际字节后才发布。
        """
        draft = {"id": 1, "draft": True, "prerelease": False, "tag_name": "v0.5.7", "target_commitish": "a" * 40}
        published = {"id": 1, "draft": False, "prerelease": False, "immutable": False, "tag_name": "v0.5.7"}
        with patch.object(RELEASE, "release_by_tag", return_value=draft), \
             patch.object(RELEASE, "github_request", side_effect=[self.archive.read_bytes(), published, self.archive.read_bytes()]), \
             patch.object(RELEASE, "resolve_sdk_tag"), patch.object(RELEASE, "release_assets", side_effect=[{}, {self.archive.name: {"id": 10}}, {self.archive.name: {"id": 10}}]), \
             patch.object(RELEASE, "run") as command:
            RELEASE.immutable_upload("test/repo", "v0.5.7", "a" * 40, [self.archive], "title", self.archive)
            self.assertEqual([call.args[0] for call in command.call_args_list], [
                ["gh", "release", "upload", "v0.5.7", self.archive, "--repo", "test/repo"],
                ["gh", "release", "edit", "v0.5.7", "--repo", "test/repo", "--draft=false"]])

    def test_create_and_resume_draft_use_authenticated_list_ids(self):
        """Model the real API where pending drafts are absent from the published-by-tag endpoint.
        模拟真实 API：待发布草稿不在已公开按标签接口中出现。
        """
        for existing in (False, True):
            with self.subTest(existing_draft=existing):
                notes = self.root / "draft-notes.md"
                notes.write_text("unit-only notes", encoding="utf-8")
                state = {"created": existing, "uploaded": False, "published": False}
                draft = {"id": 7, "tag_name": "v0.5.7", "draft": True, "prerelease": False, "target_commitish": "a" * 40}
                published = {**draft, "draft": False, "immutable": False}
                calls = []

                def reader(repository, path, binary=False):
                    """Serve actual list/ID routes and forbid using published-by-tag to read a draft.
                    提供真实列表、ID 路由，禁止用已公开按标签接口读取草稿。
                    """
                    if path.startswith("releases/tags/"):
                        raise RELEASE.urllib.error.HTTPError("https://api.github.com/fixture", 404, "draft is not published", {}, None)
                    if path == "git/ref/tags/v0.5.7":
                        if not state["published"]:
                            raise RELEASE.urllib.error.HTTPError("https://api.github.com/repos/test/repo/git/ref/tags/v0.5.7", 404, "pending tag", {}, None)
                        return {"ref": "refs/tags/v0.5.7", "object": {"type": "commit", "sha": "a" * 40}}
                    if path == "releases?per_page=100&page=1":
                        return [draft] if state["created"] else []
                    if path == "releases?per_page=100&page=2":
                        return []
                    if path == "releases/7/assets?per_page=100&page=1":
                        return [{"id": 100, "name": self.archive.name}] if state["uploaded"] else []
                    if path == "releases/7/assets?per_page=100&page=2":
                        return []
                    if path == "releases/assets/100":
                        self.assertTrue(state["uploaded"])
                        return self.archive.read_bytes()
                    if path == "releases/7":
                        self.assertTrue(state["published"])
                        return published
                    raise AssertionError("Unexpected draft API route: " + path)

                def command(arguments):
                    """Mutate only the unit fixture after validating create, upload and public ordering.
                    验证创建、上传、公开顺序后，仅变更单测夹具。
                    """
                    calls.append(arguments)
                    if arguments[:3] == ["gh", "release", "create"]:
                        self.assertFalse(state["created"])
                        self.assertIn("--draft", arguments)
                        self.assertNotIn(self.archive, arguments)
                        state["created"] = True
                    elif arguments[:3] == ["gh", "release", "upload"]:
                        self.assertTrue(state["created"])
                        self.assertFalse(state["published"])
                        state["uploaded"] = True
                    elif arguments[:3] == ["gh", "release", "edit"]:
                        self.assertTrue(state["uploaded"])
                        self.assertIn("--draft=false", arguments)
                        state["published"] = True
                    else:
                        raise AssertionError("Unexpected draft command")
                    return ""

                with patch.object(RELEASE, "github_request", side_effect=reader), patch.object(RELEASE, "run", side_effect=command):
                    RELEASE.immutable_upload("test/repo", "v0.5.7", "a" * 40, [self.archive], "title", notes)
                expected = ["upload", "edit"] if existing else ["create", "upload", "edit"]
                self.assertEqual([call[2] for call in calls], expected)
                self.assertTrue(state["published"])

    def test_wrong_actual_tag_prevents_every_sdk_and_example_release_mutation(self):
        """Reject a wrong recursive real tag despite a matching draft target, before upload/create/edit.
        草稿目标匹配但递归真实标签错误时，在上传、创建、公开前拒绝。
        """
        for tag in ("v0.5.7", "examples-v0.5.7"):
            for draft_exists in (False, True):
                with self.subTest(tag=tag, draft_exists=draft_exists):
                    draft = {"id": 7, "tag_name": tag, "draft": True, "prerelease": False, "target_commitish": "a" * 40}

                    def reader(repository, path, binary=False):
                        """Keep published-by-tag absent and expose the separate real annotated Git reference.
                        保持已公开按标签查询缺失，独立暴露真实附注 Git 引用。
                        """
                        if path.startswith("releases/tags/"):
                            raise RELEASE.urllib.error.HTTPError("https://api.github.com/fixture", 404, "draft", {}, None)
                        if path == "releases?per_page=100&page=1":
                            return [draft] if draft_exists else []
                        if path == "releases?per_page=100&page=2":
                            return []
                        if path == "git/ref/tags/" + tag:
                            return {"ref": "refs/tags/" + tag, "object": {"type": "tag", "sha": "c" * 40}}
                        if path == "git/tags/" + "c" * 40:
                            return {"sha": "c" * 40, "object": {"type": "tag", "sha": "d" * 40}}
                        if path == "git/tags/" + "d" * 40:
                            return {"sha": "d" * 40, "object": {"type": "commit", "sha": "b" * 40}}
                        raise AssertionError("Unexpected tag API route: " + path)

                    with patch.object(RELEASE, "github_request", side_effect=reader), patch.object(RELEASE, "run") as command, \
                         patch.object(RELEASE, "release_assets") as assets, self.assertRaisesRegex(ValueError, "tag/source mismatch"):
                        RELEASE.immutable_upload("test/repo", tag, "a" * 40, [self.archive], "title", self.archive)
                    command.assert_not_called()
                    assets.assert_not_called()

    def test_only_initial_exact_tag_ref_404_means_absence(self):
        """Reject nested-object or unexpected-origin 404 while typing only the initial exact missing ref.
        拒绝嵌套对象及非预期来源 404，仅初始精确引用缺失可具备专用类型。
        """
        reference = {"ref": "refs/tags/v0.5.7", "object": {"type": "tag", "sha": "c" * 40}}
        for initial, url, expected in ((True, "https://api.github.com/repos/test/repo/git/ref/tags/v0.5.7", RELEASE.SDKTagMissing),
                                       (True, "https://api.github.com/unexpected", RELEASE.urllib.error.HTTPError),
                                       (False, "https://api.github.com/repos/test/repo/git/tags/" + "c" * 40, RELEASE.urllib.error.HTTPError)):
            with self.subTest(initial=initial, url=url):
                error = RELEASE.urllib.error.HTTPError(url, 404, "unit-only missing ref/object", {}, None)
                self.addCleanup(error.close)
                replies = [error] if initial else [reference, error]
                with patch.object(RELEASE, "github_request", side_effect=replies), self.assertRaises(expected):
                    RELEASE.resolve_sdk_tag("test/repo", "v0.5.7", "a" * 40)

    def test_preflight_existing_unresolved_annotation_never_authorizes(self):
        """Preserve an existing annotated-ref object's 404 as unknown despite a valid source/workflow.
        即使源码、工作流有效，既有附注引用对象的 404 仍保留为未知。
        """
        args = SimpleNamespace(repository="test/repo", version="0.5.7", sdk_source_sha="a" * 40,
                               output=self.root / "preflight.json")
        error = RELEASE.urllib.error.HTTPError("https://api.github.com/repos/test/repo/git/tags/" + "c" * 40, 404, "missing annotation", {}, None)
        self.addCleanup(error.close)
        replies = [{"full_name": "test/repo", "permissions": {"push": True}, "default_branch": "main"},
                   {"object": {"type": "commit", "sha": "a" * 40}},
                   {"type": "file", "encoding": "base64", "content": RELEASE.base64.b64encode((ROOT / ".github/workflows/sdk-release.yml").read_bytes()).decode()},
                   {"ref": "refs/tags/v0.5.7", "object": {"type": "tag", "sha": "c" * 40}}, error]
        with patch.object(RELEASE, "github_request", side_effect=replies), self.assertRaises(RELEASE.urllib.error.HTTPError):
            RELEASE.publication_preflight(args)
        self.assertFalse(args.output.exists())

    def test_unresolved_annotation_prevents_every_release_mutation(self):
        """Fail SDK/examples create/resume before any mutation when a real existing tag cannot resolve.
        真实既有标签不能解析时，SDK、示例新建及恢复在任何变更前失败。
        """
        for tag in ("v0.5.7", "examples-v0.5.7"):
            for draft_exists in (False, True):
                with self.subTest(tag=tag, draft_exists=draft_exists):
                    draft = {"id": 7, "tag_name": tag, "draft": True, "prerelease": False, "target_commitish": "a" * 40}
                    error = RELEASE.urllib.error.HTTPError("https://api.github.com/repos/test/repo/git/tags/" + "c" * 40, 404, "missing annotation", {}, None)
                    self.addCleanup(error.close)

                    def reader(repository, path, binary=False):
                        """Serve a present exact ref and fail its object lookup, with published-by-tag still absent.
                        提供存在的精确引用并使其对象查询失败，已公开按标签查询仍缺失。
                        """
                        if path.startswith("releases/tags/"):
                            raise RELEASE.urllib.error.HTTPError("https://api.github.com/fixture", 404, "draft", {}, None)
                        if path == "releases?per_page=100&page=1":
                            return [draft] if draft_exists else []
                        if path == "releases?per_page=100&page=2":
                            return []
                        if path == "git/ref/tags/" + tag:
                            return {"ref": "refs/tags/" + tag, "object": {"type": "tag", "sha": "c" * 40}}
                        if path == "git/tags/" + "c" * 40:
                            raise error
                        raise AssertionError("Unexpected unresolved tag route: " + path)

                    with patch.object(RELEASE, "github_request", side_effect=reader), patch.object(RELEASE, "run") as command, \
                         patch.object(RELEASE, "release_assets") as assets, self.assertRaises(RELEASE.urllib.error.HTTPError):
                        RELEASE.immutable_upload("test/repo", tag, "a" * 40, [self.archive], "title", self.archive)
                    command.assert_not_called()
                    assets.assert_not_called()

    def test_prepublication_tag_recheck_rejects_nested_404_without_edit(self):
        """Recheck a previously valid tag before public edit and reject a newly unresolved annotation.
        公开变更前重查先前有效标签，拒绝新出现的附注对象无法解析。
        """
        for tag in ("v0.5.7", "examples-v0.5.7"):
            with self.subTest(tag=tag):
                draft = {"id": 7, "tag_name": tag, "draft": True, "prerelease": False, "target_commitish": "a" * 40}
                state = {"refs": 0}
                error = RELEASE.urllib.error.HTTPError("https://api.github.com/repos/test/repo/git/tags/" + "c" * 40, 404, "missing annotation", {}, None)
                self.addCleanup(error.close)

                def reader(repository, path, binary=False):
                    """Serve matching existing draft bytes and make only the final real tag lookup unresolved.
                    提供匹配的既有草稿字节，仅使最后真实标签查询无法解析。
                    """
                    if path == "git/ref/tags/" + tag:
                        state["refs"] += 1
                        kind = "commit" if state["refs"] == 1 else "tag"
                        sha = "a" * 40 if state["refs"] == 1 else "c" * 40
                        return {"ref": "refs/tags/" + tag, "object": {"type": kind, "sha": sha}}
                    if path == "git/tags/" + "c" * 40:
                        raise error
                    if path == "releases/assets/10":
                        return self.archive.read_bytes()
                    raise AssertionError("Unexpected final tag recheck route: " + path)

                with patch.object(RELEASE, "release_by_tag", return_value=draft), patch.object(RELEASE, "github_request", side_effect=reader), \
                     patch.object(RELEASE, "release_assets", return_value={self.archive.name: {"id": 10}}), \
                     patch.object(RELEASE, "run") as command, self.assertRaises(RELEASE.urllib.error.HTTPError):
                    RELEASE.immutable_upload("test/repo", tag, "a" * 40, [self.archive], "title", self.archive)
                command.assert_not_called()
                self.assertEqual(state["refs"], 2)

    def test_existing_exact_npm_bytes_reused_without_publish(self):
        """Download real tgz bytes through the official metadata boundary and reuse without npm mutation.
        经官方元数据边界下载真实 tgz 字节，无 npm 变更地复用。
        """
        args = self.publication_args()
        args.output = self.root / "publication.json"
        stack, command = self.publication_context([self.npm_metadata()], [io.BytesIO(self.archive.read_bytes())], None)
        with stack:
            RELEASE.publish_or_verify(args)
        command.assert_not_called()
        self.assertEqual(RELEASE.read_json(args.output)["action"], "reused")

    def test_existing_changed_npm_bytes_fail_without_publish(self):
        """Reject a changed official tarball before any npm publish and omit success evidence.
        官方 tarball 字节变化时在 npm 发布前拒绝，不输出成功证据。
        """
        args = self.publication_args()
        args.output = self.root / "publication.json"
        stack, command = self.publication_context([self.npm_metadata()], [io.BytesIO(b"other bytes")], None)
        with stack, self.assertRaisesRegex(ValueError, "differs from tested"):
            RELEASE.publish_or_verify(args)
        command.assert_not_called()
        self.assertFalse(args.output.exists())

    def test_only_exact_version_404_publishes_once_then_checks_actual_bytes(self):
        """Publish only after exact version absence and require a fresh post-publish actual tgz download.
        仅精确版本缺失后发布，且要求发布后全新下载实际 tgz。
        """
        args = self.publication_args()
        args.output = self.root / "publication.json"
        completed = RELEASE.subprocess.CompletedProcess([], 0, "{}", "")
        stack, command = self.publication_context([self.missing_npm_version(), self.npm_metadata()],
                                                  [io.BytesIO(self.archive.read_bytes())], completed)
        with stack:
            RELEASE.publish_or_verify(args)
        command.assert_called_once()
        self.assertEqual(command.call_args.args[0], ["unit-only-npm", "publish", str(self.archive), "--ignore-scripts", "--provenance",
                                                     "--access", "public", "--registry", "https://registry.npmjs.org", "--json"])
        self.assertEqual(RELEASE.read_json(args.output)["action"], "published")

    def test_registry_unknown_or_missing_tarball_never_publishes(self):
        """Reject permission/service states and a broken existing tarball without interpreting them as absence.
        拒绝权限、服务状态及既有 tarball 损坏，不能把这些解释成缺失。
        """
        args = self.publication_args()
        for code in (401, 403, 503):
            with self.subTest(code=code):
                args.output = self.root / f"publication-{code}.json"
                stack, command = self.publication_context([self.missing_npm_version(code)], [], None)
                with stack, self.assertRaises(RELEASE.urllib.error.HTTPError):
                    RELEASE.publish_or_verify(args)
                command.assert_not_called()
                self.assertFalse(args.output.exists())
        args.output = self.root / "tarball-404.json"
        error = RELEASE.urllib.error.HTTPError(self.npm_metadata()["dist"]["tarball"], 404, "missing tarball", {}, None)
        self.addCleanup(error.close)
        stack, command = self.publication_context([self.npm_metadata()], [error], None)
        with stack, self.assertRaises(RELEASE.urllib.error.HTTPError):
            RELEASE.publish_or_verify(args)
        command.assert_not_called()
        self.assertFalse(args.output.exists())

    def test_npm_race_requires_exact_fresh_registry_bytes(self):
        """Accept only explicit known version races followed by real exact bytes; reject a changed winner.
        仅明确已知版本竞争加真实精确字节可通过；拒绝获胜者字节变化。
        """
        args = self.publication_args()
        errors = [{"code": "EPUBLISHCONFLICT", "summary": "Cannot publish over existing version."},
                  {"code": "E409", "summary": "Conflict"},
                  {"summary": f"You cannot publish over the previously published versions: {self.identity['sdk_version']}."}]
        for index, error in enumerate(errors):
            with self.subTest(error=error):
                args.output = self.root / f"race-{index}.json"
                completed = RELEASE.subprocess.CompletedProcess([], 1, json.dumps({"error": error}), "")
                stack, command = self.publication_context([self.missing_npm_version(), self.npm_metadata()],
                                                          [io.BytesIO(self.archive.read_bytes())], completed)
                with stack:
                    RELEASE.publish_or_verify(args)
                command.assert_called_once()
                self.assertEqual(RELEASE.read_json(args.output)["action"], "race-reused")
        args.output = self.root / "race-changed.json"
        stack, command = self.publication_context([self.missing_npm_version(), self.npm_metadata()], [io.BytesIO(b"changed winner")], completed)
        with stack, self.assertRaisesRegex(ValueError, "differs from tested"):
            RELEASE.publish_or_verify(args)
        command.assert_called_once()
        self.assertFalse(args.output.exists())

    def test_npm_publish_unknown_error_never_becomes_registry_success(self):
        """Fail closed for permission/service/unstructured errors instead of rechecking arbitrary publish failures.
        权限、服务、无结构错误必须失败，不能将任意发布失败变成注册表复核成功。
        """
        args = self.publication_args()
        for index, error in enumerate(({"code": "E403", "summary": "Forbidden"}, {"code": "E503", "summary": "Unavailable"},
                                        {"summary": "Unknown failure"}, {"code": "E403", "summary": f"You cannot publish over the previously published versions: {self.identity['sdk_version']}."})):
            with self.subTest(error=error):
                args.output = self.root / f"failure-{index}.json"
                completed = RELEASE.subprocess.CompletedProcess([], 1, json.dumps({"error": error}), "")
                stack, command = self.publication_context([self.missing_npm_version()], [], completed)
                with stack, self.assertRaisesRegex(ValueError, "npm publication failed"):
                    RELEASE.publish_or_verify(args)
                command.assert_called_once()
                self.assertFalse(args.output.exists())

    def test_publication_source_or_matrix_drift_prevents_registry_and_publish(self):
        """Check the publication wrapper rejects actual freeze/matrix drift before any external registry operation.
        验证发布入口在任何外部注册表操作前拒绝冻结身份、矩阵漂移。
        """
        args = self.publication_args()
        args.output = self.root / "source-drift.json"
        stack, command = self.publication_context([], [], None)
        with stack, patch.object(RELEASE, "run", return_value="c" * 40), self.assertRaisesRegex(ValueError, "source/workflow SHA"):
            RELEASE.publish_or_verify(args)
        command.assert_not_called()
        self.assertFalse(args.output.exists())
        args.output = self.root / "aggregate-drift.json"
        proof = RELEASE.read_json(args.aggregate)
        proof["complete"] = False
        args.aggregate.write_text(json.dumps(proof), encoding="utf-8")
        stack, command = self.publication_context([], [], None)
        with stack, self.assertRaisesRegex(ValueError, "Publication aggregate changed"):
            RELEASE.publish_or_verify(args)
        command.assert_not_called()
        self.assertFalse(args.output.exists())


    def test_formal_npm_tarball_hash_mismatch_rejected(self):
        """Reject an official-version response if its actual package bytes differ from tested tgz.
        官方版本响应的实际包字节与被测 tgz 不同时拒绝。
        """
        metadata = {"name": "@luaskills/sdk", "version": self.identity["sdk_version"],
                    "dist": {"tarball": "https://registry.npmjs.org/@luaskills/sdk/-/sdk.tgz"}}
        with patch.object(RELEASE, "request_json", return_value=metadata), \
             patch.object(RELEASE.urllib.request, "urlopen", return_value=io.BytesIO(b"other-package")), \
             self.assertRaisesRegex(ValueError, "differs from tested"):
            RELEASE.registry_package(self.identity, self.root)

    def attestation_fixture(self):
        """Return the official verified-output shape with clearly unit-only certificate values.
        返回官方验证输出形状，证书值明确仅限单测。
        """
        invocation = "https://github.com/test/repo/actions/runs/123/attempts/1"
        certificate = {"runInvocationURI": invocation, "sourceRepositoryURI": "https://github.com/test/repo",
            "sourceRepositoryDigest": "a" * 40, "buildSignerDigest": "a" * 40,
            "sourceRepositoryRef": "refs/heads/main", "buildSignerURI": "https://github.com/test/repo/.github/workflows/sdk-release.yml@refs/heads/main",
            "runnerEnvironment": "github-hosted"}
        return [{"verificationResult": {"signature": {"certificate": certificate}, "statement": {
            "predicateType": "https://slsa.dev/provenance/v1", "subject": [{"name": self.archive.name, "digest": {"sha256": RELEASE.digest(self.archive)}}],
            "predicate": {"runDetails": {"metadata": {"invocationId": invocation}}}}}}]

    def test_official_attestation_command_binds_actual_subject_and_certificate(self):
        """Require exact official verifier policy and actual subject/run/source certificate fields.
        要求精确官方验证器策略及实际主体、运行、源码证书字段。
        """
        bundle = self.root / "sigstore.jsonl"
        bundle.write_text("unit-only-bundle", encoding="utf-8")
        with patch.object(RELEASE, "run", return_value=json.dumps(self.attestation_fixture())) as command:
            RELEASE.verify_attestation(self.archive, bundle, "test/repo", "a" * 40, "123", 1, "refs/heads/main")
        self.assertEqual(command.call_args.args[0], ["gh", "attestation", "verify", self.archive, "--repo", "test/repo",
            "--signer-workflow", "test/repo/.github/workflows/sdk-release.yml", "--source-digest", "a" * 40,
            "--signer-digest", "a" * 40, "--source-ref", "refs/heads/main", "--deny-self-hosted-runners", "--bundle", bundle, "--format", "json"])

    def test_signed_certificate_subject_or_invocation_mutations_fail(self):
        """Self-rehashed metadata cannot replace the authenticated certificate, invocation or subject.
        自行重算摘要的元数据不能替代认证证书、调用或主体。
        """
        changes = [lambda r: r["signature"]["certificate"].update(runInvocationURI="https://github.com/test/repo/actions/runs/999/attempts/1"),
                   lambda r: r["signature"]["certificate"].update(sourceRepositoryDigest="0" * 40),
                   lambda r: r["signature"]["certificate"].update(buildSignerDigest="0" * 40),
                   lambda r: r["signature"]["certificate"].update(runnerEnvironment="self-hosted"),
                   lambda r: r["statement"]["subject"][0]["digest"].update(sha256="0" * 64),
                   lambda r: r["statement"]["predicate"]["runDetails"]["metadata"].update(invocationId="forged"),
                   lambda r: r["statement"].update(predicateType="unsupported")]
        for change in changes:
            with self.subTest(change=change):
                fixture = self.attestation_fixture()
                change(fixture[0]["verificationResult"])
                with patch.object(RELEASE, "run", return_value=json.dumps(fixture)), self.assertRaises(ValueError):
                    RELEASE.verify_attestation(self.archive, self.archive, "test/repo", "a" * 40, "123", 1, "refs/heads/main")
        with patch.object(RELEASE, "run", side_effect=ValueError("official signature verification failed")), self.assertRaisesRegex(ValueError, "official signature"):
            RELEASE.verify_attestation(self.archive, self.archive, "test/repo", "a" * 40, "123", 1, "refs/heads/main")



    def recovery_environment(self, run_id=123, attempt=2, intent="artifact-only", workflow=RELEASE.SDK_WORKFLOW):
        """Return explicit current GitHub identity for unit-only signed candidate/completion fixtures.
        返回单测签名候选、完成夹具的明确当前 GitHub 身份。
        """
        return {"GITHUB_SHA": self.identity["sdk_source_sha"], "GITHUB_WORKFLOW_SHA": self.identity["sdk_source_sha"],
            "GITHUB_RUN_ID": str(run_id), "GITHUB_RUN_ATTEMPT": str(attempt), "GITHUB_REF": "refs/heads/main",
            "GITHUB_WORKFLOW_REF": "test/repo/" + workflow + "@refs/heads/main", "DEFAULT_BRANCH": "main", "COMPLETION_INTENT": intent}

    def add_attempt(self, run_id, attempt, names, conclusion="failure", mode="artifact-only", workflow=RELEASE.SDK_WORKFLOW):
        """Register exact attempt/jobs responses without latest lookup; return its mutable actual run.
        注册精确轮次、作业响应而不查询最新状态；返回可变实际运行。
        """
        endpoint = f"https://api.github.com/repos/test/repo/actions/runs/{run_id}/attempts/{attempt}"
        actual = {"id": run_id, "run_attempt": attempt, "repository": {"full_name": "test/repo"}, "head_repository": {"full_name": "test/repo"},
            "head_sha": self.identity["sdk_source_sha"], "head_branch": "main", "path": workflow + "@main", "workflow_id": 7,
            "event": "workflow_dispatch", "display_title": ("SDK " if workflow == RELEASE.SDK_WORKFLOW else "Examples ") + self.identity["sdk_source_sha"] + " mode=" + mode,
            "status": "completed" if conclusion is not None else "in_progress", "conclusion": conclusion}
        jobs = [{"id": 1000 + index, "run_id": run_id, "head_sha": self.identity["sdk_source_sha"], "run_url": f"https://api.github.com/repos/test/repo/actions/runs/{run_id}",
            "name": name, "status": "completed", "conclusion": "success"} for index, name in enumerate(names)]
        self.http.responses[endpoint] = actual
        self.http.responses[endpoint + "/jobs?per_page=100&page=1"] = {"total_count": len(jobs), "jobs": jobs}
        return actual

    def fixture_signature(self, directory, name, run_id, attempt, workflow=RELEASE.SDK_WORKFLOW):
        """Store clearly synthetic official verifier output for every physical subject; no cryptographic success is claimed.
        保存每个物理主体的明确合成官方验证器输出；不声称加密验签成功。
        """
        marker = f"unit-only-signature-{workflow}-{run_id}-{attempt}"
        (directory / name).write_text(marker, encoding="utf-8")
        files = {path.name: path.read_bytes() for path in directory.iterdir() if path.is_file() and path.name != name}
        self.signatures[marker] = {"run_id": run_id, "attempt": attempt, "workflow": workflow, "files": files}

    def recovery_command(self, arguments, *extra, **keywords):
        """Replace git/official-verifier process boundaries only, preserving production parser and every byte check.
        仅替换 Git、官方验证器进程边界，保留生产解析器及每个字节检查。
        """
        if arguments[:3] == ["git", "rev-parse", "HEAD"]:
            return self.identity["sdk_source_sha"]
        if arguments[:3] == ["gh", "attestation", "verify"]:
            marker = Path(arguments[arguments.index("--bundle") + 1]).read_text(encoding="utf-8")
            signed = self.signatures[marker]
            invocation = RECOVERY.invocation_uri("test/repo", signed["run_id"], signed["attempt"])
            certificate = {"runInvocationURI": invocation, "sourceRepositoryURI": "https://github.com/test/repo",
                "sourceRepositoryDigest": self.identity["sdk_source_sha"], "buildSignerDigest": self.identity["sdk_source_sha"],
                "sourceRepositoryRef": "refs/heads/main", "buildSignerURI": "https://github.com/test/repo/" + signed["workflow"] + "@refs/heads/main", "runnerEnvironment": "github-hosted"}
            subjects = [{"name": name, "digest": {"sha256": hashlib.sha256(body).hexdigest()}} for name, body in signed["files"].items()]
            return json.dumps([{"verificationResult": {"signature": {"certificate": certificate}, "statement": {
                "predicateType": "https://slsa.dev/provenance/v1", "subject": subjects, "predicate": {"runDetails": {"metadata": {"invocationId": invocation}}}}}}])
        raise AssertionError("Unexpected recovery process: " + str(arguments))

    def recovery_context(self):
        """Bind real public recovery authority to an offline HTTP transport and exact unit-only core resolver.
        将真实公共恢复权威绑定到离线 HTTP 传输及精确仅限单测核心解析器。
        """
        shared = self.shared_fixture()
        shared.Http = lambda: self.http
        stack = contextlib.ExitStack()
        stack.enter_context(patch.object(RELEASE, "authority", return_value=CORE))
        stack.enter_context(patch.object(RELEASE, "shared_gate", return_value=shared))
        stack.enter_context(patch.object(RELEASE, "recovery_authority", return_value=(RECOVERY, shared)))
        stack.enter_context(patch.object(RELEASE, "run", side_effect=self.recovery_command))
        return stack

    def original_candidate_fixture(self):
        """Build the real schema2 bundle around actual tgz, full synthetic native logs and core bytes; return frozen files.
        围绕真实 tgz、完整合成原生日志及核心字节构建实际 schema2 包；返回冻结文件。
        """
        self.http = RecoveryHttp({})
        self.signatures = {}
        for key in CORE.PLATFORMS:
            (self.evidence / (key + ".json")).unlink()
            folder = self.evidence / ("native-" + key)
            folder.mkdir()
            RELEASE.write_json(folder / "result.json", self.records[key])
            (folder / "native.stdout.log").write_text(json.dumps(self.records[key]["test"]) + "\n", encoding="utf-8")
            (folder / "native.stderr.log").write_bytes(b"")
        self.aggregate()
        core = self.root / "core-proof"
        core.mkdir()
        (core / "prerequisites.json").write_bytes(self.prerequisites.read_bytes())
        (core / "actual-core.log").write_bytes(b"unit-only complete core evidence")
        self.add_attempt(123, 2, RELEASE.candidate_jobs(OPTIONS.core_root))
        directory = self.root / "signed-candidate"
        args = SimpleNamespace(core_root=OPTIONS.core_root, repository="test/repo", mode="artifact-only", artifact=self.artifact,
            aggregate=self.args.output, prerequisites=core / "prerequisites.json", evidence_dir=self.evidence, output=directory)
        with self.recovery_context(), patch.dict(os.environ, self.recovery_environment()):
            with contextlib.redirect_stdout(io.StringIO()) as stdout:
                RELEASE.candidate_bundle(args)
            self.assertEqual(stdout.getvalue().strip(), RECOVERY.candidate_artifact_name(123, 2))
        self.fixture_signature(directory, RELEASE.CANDIDATE_ATTESTATION, 123, 2)
        with self.recovery_context(), patch.dict(os.environ, self.recovery_environment()):
            RELEASE.candidate_seal(SimpleNamespace(core_root=OPTIONS.core_root, input=directory))
        files = {path.name: path.read_bytes() for path in directory.iterdir()}
        self.register_artifact(files, 77)
        return directory, files

    def register_artifact(self, files, artifact_id=77, run_id=123, attempt=2):
        """Build a real root-file ZIP and exact API metadata for the explicit uploaded artifact ID.
        为明确上传制品 ID 构建实际根文件 ZIP 及精确 API 元数据。
        """
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, "w", compression=zipfile.ZIP_STORED) as archive:
            for name, body in files.items():
                archive.writestr(name, body)
        body = stream.getvalue()
        endpoint = f"https://api.github.com/repos/test/repo/actions/artifacts/{artifact_id}"
        self.http.responses[endpoint] = {"id": artifact_id, "name": RECOVERY.candidate_artifact_name(run_id, attempt), "expired": False,
            "workflow_run": {"id": run_id, "head_sha": self.identity["sdk_source_sha"]}, "size_in_bytes": len(body), "digest": "sha256:" + hashlib.sha256(body).hexdigest()}
        self.http.responses[endpoint + "/zip"] = body

    def fetch_args(self, output="restored"):
        """Return explicit candidate download inputs using the original second attempt, never the latest.
        返回使用原第二轮次的明确候选下载输入，绝不使用最新轮次。
        """
        return SimpleNamespace(core_root=OPTIONS.core_root, repository="test/repo", sdk_source_sha=self.identity["sdk_source_sha"],
            candidate_run_id="123", candidate_run_attempt="2", candidate_artifact_id="77", output=self.root / output)

    def test_original_failed_whole_attempt_restores_exact_signed_bytes(self):
        """Recover successful original candidate gates while retaining their actual whole-attempt failure and mode.
        恢复成功原候选门禁，同时保留实际整轮失败及模式。
        """
        _, files = self.original_candidate_fixture()
        args = self.fetch_args()
        with self.recovery_context():
            RELEASE.candidate_fetch(args)
            state = RELEASE.local_candidate(SimpleNamespace(core_root=OPTIONS.core_root, repository="test/repo", candidate=args.output))
        self.assertEqual(state["attempt"]["attempt"]["conclusion"], "failure")
        self.assertEqual(state["manifest"]["mode"], "artifact-only")
        self.assertEqual({p.name: p.read_bytes() for p in (args.output / "original").iterdir()}, files)
        self.assertFalse(any("filter=latest" in url or url.endswith("actions/runs/123") for url in self.http.calls))

    def test_current_active_candidate_preserves_actual_state(self):
        """Accept completed signed evidence gates during an active publish attempt without synthesizing success.
        在运行中发布轮次接受已完成签名证据门禁，不合成成功状态。
        """
        self.original_candidate_fixture()
        self.http.responses["https://api.github.com/repos/test/repo/actions/runs/123/attempts/2"].update(status="in_progress", conclusion=None)
        with self.recovery_context():
            RELEASE.candidate_fetch(self.fetch_args())
        header = RELEASE.read_json(self.root / "restored/candidate-authentication.json")
        self.assertEqual(header["attempt"]["attempt"]["status"], "in_progress")
        self.assertIsNone(header["attempt"]["attempt"]["conclusion"])

    def test_unknown_attempt_gate_missing_artifact_and_signature_fail_before_mutation(self):
        """Reject missing/unknown original authority, failed gates and expired/unsigned files before every publication call.
        在每次发布调用前拒绝缺失、未知原权威、失败门禁及过期、无签名文件。
        """
        _, original = self.original_candidate_fixture()
        endpoint = "https://api.github.com/repos/test/repo/actions/runs/123/attempts/2"
        mutations = [lambda: self.http.responses[endpoint].update(status="queued", conclusion=None),
            lambda: self.http.responses[endpoint + "/jobs?per_page=100&page=1"]["jobs"][-1].update(conclusion="failure"),
            lambda: self.http.responses["https://api.github.com/repos/test/repo/actions/artifacts/77"].update(expired=True),
            lambda: self.http.responses.pop("https://api.github.com/repos/test/repo/actions/artifacts/77"),
            lambda: self.register_artifact({n:b for n,b in original.items() if n != RELEASE.CANDIDATE_ATTESTATION}),
            lambda: self.register_artifact({**original, self.archive.name: b"modified original tgz"})]
        baseline = copy.deepcopy(self.http.responses)
        for index, mutate in enumerate(mutations):
            with self.subTest(index=index):
                self.http.responses = copy.deepcopy(baseline)
                mutate()
                args = self.fetch_args("rejected-" + str(index))
                with self.recovery_context(), patch.object(RELEASE, "immutable_upload") as mutation, patch.object(RELEASE, "npm_publish_archive") as npm, self.assertRaises(ValueError):
                    RELEASE.candidate_fetch(args)
                mutation.assert_not_called()
                npm.assert_not_called()
                self.assertFalse((args.output / "candidate-authentication.json").exists())

    def test_explicit_original_attempt_cannot_use_other_attempt_signature(self):
        """An original artifact's signature cannot be rebound to another explicit successful API attempt.
        原制品签名不能重新绑定到另一明确成功 API 轮次。
        """
        self.original_candidate_fixture()
        self.add_attempt(123, 3, RELEASE.candidate_jobs(OPTIONS.core_root), conclusion="success")
        args = self.fetch_args()
        args.candidate_run_attempt = "3"
        self.http.responses["https://api.github.com/repos/test/repo/actions/artifacts/77"]["name"] = RECOVERY.candidate_artifact_name(123, 3)
        with self.recovery_context(), self.assertRaisesRegex(ValueError, "certificate issuer/source/run"):
            RELEASE.candidate_fetch(args)

    def completion_fixture(self):
        """Create a new signed completion referencing an actual unit-only main Release with unchanged original package bytes.
        创建引用实际单测主 Release 的新签名完成证明，保持原包字节不变。
        """
        _, files = self.original_candidate_fixture()
        with self.recovery_context():
            RELEASE.candidate_fetch(self.fetch_args())
        self.add_attempt(456, 3, [RELEASE.workflow_job_name(RELEASE.SDK_WORKFLOW,"publish")], conclusion="success", mode="recover")
        self.release_files = {11: files}
        self.releases = {11: {"id":11,"tag_name":"v" + self.identity["sdk_version"],"draft":False,"prerelease":False,"immutable":False}}
        root = self.root / "restored"
        consumer = self.root / "fresh-consumer.json"
        RELEASE.write_json(consumer, {"schema_version":1,"artifact":self.identity,"success":True,"cache":"new-empty-cache","test":next(iter(self.records.values()))["test"]})
        proof = self.root / "fresh-aggregate.json"
        core = root / "core-prerequisites/prerequisites.json"
        main = self.root / "main-release.json"
        RELEASE.write_json(main, self.releases[11])
        args = SimpleNamespace(core_root=OPTIONS.core_root, repository="test/repo", candidate=root, intent="recover", consumer=consumer,
            aggregate=proof, prerequisites=core, main_release=main, output=self.root / "completion")
        with self.recovery_context(), patch.object(RELEASE,"github_request",side_effect=self.recovery_reader), patch.dict(os.environ,self.recovery_environment(456,3,"recover")):
            RELEASE.aggregate(SimpleNamespace(core_root=OPTIONS.core_root, artifact=root/"original"/RELEASE.RELEASE_FILES["artifact"],
                prerequisites=core,evidence_dir=root/"native-evidence",output=proof))
            RELEASE.completion_bundle(args)
        self.fixture_signature(args.output, RELEASE.COMPLETION_ATTESTATION, 456, 3)
        self.release_files[22] = {p.name:p.read_bytes() for p in args.output.iterdir()}
        self.releases[22] = {"id":22,"tag_name":RELEASE.completion_tag(self.identity["sdk_version"],456,3),"draft":False,"prerelease":False,"immutable":False}
        return args

    def recovery_reader(self, repository, path, binary=False):
        """Expose real ID/tag/assets routes for permanent original/completion files and fail undefined API requests.
        暴露持久原候选、完成文件的真实 ID、标签、资产路由，对未定义 API 请求失败。
        """
        self.assertEqual(repository,"test/repo")
        if path.startswith("actions/"):
            return self.http.json("https://api.github.com/repos/test/repo/" + path)
        if path.startswith("git/ref/tags/"):
            tag=path.removeprefix("git/ref/tags/")
            return {"ref":"refs/tags/"+tag,"object":{"type":"commit","sha":self.identity["sdk_source_sha"]}}
        if path.startswith("releases/tags/"):
            tag=path.removeprefix("releases/tags/")
            return next(record for record in self.releases.values() if record["tag_name"]==tag)
        if path.startswith("releases/assets/"):
            self.assertTrue(binary)
            number=int(path.removeprefix("releases/assets/"))
            release_id,index=divmod(number,100)
            return list(sorted(self.release_files[release_id].items()))[index][1]
        if "/assets?per_page=100&page=" in path:
            release_id=int(path.split("/")[1])
            if path.endswith("page=1"):
                return [{"id":release_id*100+index,"name":name,"size":len(body)} for index,(name,body) in enumerate(sorted(self.release_files[release_id].items()))]
            return []
        if path.startswith("releases/"):
            return self.releases[int(path.removeprefix("releases/"))]
        raise AssertionError("Unexpected permanent recovery URL: " + path)

    def formal_args(self):
        """Return the explicit original and completion consumer identities, preserving all four run/attempt inputs.
        返回明确原候选、完成消费身份，保留全部四个运行、轮次输入。
        """
        return SimpleNamespace(core_root=OPTIONS.core_root,repository="test/repo",sdk_source_sha=self.identity["sdk_source_sha"],sdk_version=self.identity["sdk_version"],
            candidate_run_id="123",candidate_run_attempt="2",completion_run_id="456",completion_run_attempt="3",
            completion_source_sha=self.identity["sdk_source_sha"],output=self.root/"formal")

    def test_dual_formal_proof_preserves_original_failure_and_requires_fresh_consumer(self):
        """Authenticate both permanent chains and emit the explicit accepted header only after a new consumer file exists.
        认证两条持久证明链，仅在新的消费文件存在后输出明确接受头。
        """
        self.completion_fixture()
        args=self.formal_args()

        def consume(options):
            """Write distinctly unit-only fresh consumer evidence without outbound npm/native execution.
            写入明确仅限单测的新消费证据，不执行外部 npm、原生调用。
            """
            RELEASE.write_json(options.output,{"unit_only":True,"artifact":self.identity,"success":True,"cache":"new-empty-cache"})

        with self.recovery_context(),patch.object(RELEASE,"github_request",side_effect=self.recovery_reader),patch.object(RELEASE,"registry_consumer",side_effect=consume):
            RELEASE.formal_proof(args)
        header=RELEASE.read_json(args.output/"accepted.json")
        self.assertEqual(header["schema_version"],2)
        self.assertNotIn("run_id",header)
        self.assertEqual((header["candidate_run_id"],header["candidate_run_attempt"],header["completion_run_id"],header["completion_run_attempt"]),("123",2,"456",3))
        self.assertEqual(header["registry_consumer_sha256"],RELEASE.digest(args.output/header["registry_consumer_file"]))
        manifest=RELEASE.read_json(args.output/"completion"/RELEASE.COMPLETION_MANIFEST)
        self.assertEqual(manifest["candidate_attempt_observation"]["attempt"]["conclusion"],"failure")

    def test_unsigned_changed_completed_or_active_completion_never_accepts(self):
        """Reject unknown/current-active completion, corrupt original/completion subjects and missing fresh consumption.
        拒绝未知、当前运行中完成、损坏原候选或完成主体，以及缺失新消费。
        """
        self.completion_fixture()
        endpoint="https://api.github.com/repos/test/repo/actions/runs/456/attempts/3"
        baseline=copy.deepcopy(self.http.responses)
        files=copy.deepcopy(self.release_files)
        mutations=[lambda:self.http.responses[endpoint].update(status="in_progress",conclusion=None),
            lambda:self.http.responses[endpoint].update(conclusion="failure"),
            lambda:self.release_files[11].update({self.archive.name:b"changed original"}),
            lambda:self.release_files[22].update({"sdk-completion-aggregate.json":b"changed completion"})]
        for index,mutate in enumerate(mutations):
            with self.subTest(index=index):
                self.http.responses=copy.deepcopy(baseline)
                self.release_files=copy.deepcopy(files)
                mutate()
                args=self.formal_args()
                args.output=self.root/str(index)
                with self.recovery_context(),patch.object(RELEASE,"github_request",side_effect=self.recovery_reader),patch.object(RELEASE,"registry_consumer") as consumer,self.assertRaises(ValueError):
                    RELEASE.formal_proof(args)
                consumer.assert_not_called()
                self.assertFalse((args.output/"accepted.json").exists())
        self.http.responses=baseline
        self.release_files=files
        args=self.formal_args()
        with self.recovery_context(),patch.object(RELEASE,"github_request",side_effect=self.recovery_reader),patch.object(RELEASE,"registry_consumer"),self.assertRaises(ValueError):
            RELEASE.formal_proof(args)
        self.assertFalse((args.output/"accepted.json").exists())

    def test_completion_retry_keeps_original_candidate_and_uses_new_unique_tag(self):
        """A failed completion retry is independently signed; original packages/manifests/bundles remain byte-identical.
        完成失败后的重试独立签名；原包、清单、bundle 保持字节完全相同。
        """
        args=self.completion_fixture()
        original={p.name:p.read_bytes() for p in (args.candidate/"original").iterdir()}
        first=RELEASE.read_json(args.output/RELEASE.COMPLETION_MANIFEST)
        self.add_attempt(456,4,[RELEASE.workflow_job_name(RELEASE.SDK_WORKFLOW,"publish")],None,"recover")
        args.output=self.root/"retry-completion"
        with self.recovery_context(),patch.object(RELEASE,"github_request",side_effect=self.recovery_reader),patch.dict(os.environ,self.recovery_environment(456,4,"recover")):
            RELEASE.completion_bundle(args)
        second=RELEASE.read_json(args.output/RELEASE.COMPLETION_MANIFEST)
        for key in ("candidate_manifest_sha256","candidate_bundle_sha256","candidate_attestation_sha256","candidate_binding_sha256","packages"):
            self.assertEqual(first[key],second[key])
        self.assertEqual(second["run_attempt"],4)
        self.assertNotEqual(RELEASE.completion_tag(self.identity["sdk_version"],456,3),RELEASE.completion_tag(self.identity["sdk_version"],456,4))
        self.assertEqual(original,{p.name:p.read_bytes() for p in (args.candidate/"original").iterdir()})

    def test_default_artifact_only_never_authorizes_mutation(self):
        """Current explicit artifact-only intent is rejected even when original candidate and source are valid.
        即使原候选与源码有效，当前明确 artifact-only 意图仍被拒绝。
        """
        args=SimpleNamespace(repository="test/repo",intent="artifact-only")
        with patch.dict(os.environ,self.recovery_environment()),patch.object(RELEASE,"github_request") as api,self.assertRaisesRegex(ValueError,"cannot authorize publication"):
            RELEASE.current_completion(args,{"identity":self.identity})
        api.assert_not_called()

    def test_public_success_with_lost_readback_reuses_exact_bytes_without_mutation(self):
        """A public edit followed by lost readback is recovered from its actual final ID/bytes without re-upload.
        公开变更后丢失回读时，从实际最终 ID、字节恢复，不重新上传。
        """
        _, files = self.original_candidate_fixture()
        directory=self.root/"signed-candidate"
        state={"public":False,"readback_lost":True}
        tag="v"+self.identity["sdk_version"]
        draft={"id":9,"tag_name":tag,"draft":True,"prerelease":False,"target_commitish":self.identity["sdk_source_sha"]}
        final={**draft,"draft":False,"immutable":False}
        ordered=sorted(files)
        assets={name:{"id":index+1,"name":name} for index,name in enumerate(ordered)}

        def reader(repository,path,binary=False):
            """Expose existing full draft bytes and fail only the first post-publication ID read.
            暴露既有完整草稿字节，仅使首次公开后的 ID 回读失败。
            """
            if path.startswith("git/ref/tags/"):
                if not state["public"]:
                    raise RELEASE.SDKTagMissing("Exact pending initial tag")
                return {"ref":"refs/tags/"+tag,"object":{"type":"commit","sha":self.identity["sdk_source_sha"]}}
            if path.startswith("releases/assets/"):
                return files[ordered[int(path.split("/")[-1])-1]]
            if path=="releases/9":
                if state["readback_lost"]:
                    state["readback_lost"]=False
                    raise ValueError("Actual publish succeeded but readback connection lost")
                return final
            raise AssertionError("Unexpected lost-readback fixture route")

        def mutate(arguments):
            """Allow only one draft public edit in this fixture and preserve every original asset.
            本夹具仅允许一次草稿公开变更，并保留每个原资产。
            """
            self.assertEqual(arguments[:3],["gh","release","edit"])
            self.assertFalse(state["public"])
            state["public"]=True

        with patch.object(RELEASE,"release_by_tag",side_effect=lambda *args:final if state["public"] else draft), \
             patch.object(RELEASE,"release_assets",return_value=assets),patch.object(RELEASE,"github_request",side_effect=reader),patch.object(RELEASE,"run",side_effect=mutate) as command:
            with self.assertRaisesRegex(ValueError,"readback connection lost"):
                RELEASE.immutable_upload("test/repo",tag,self.identity["sdk_source_sha"],sorted(directory.iterdir()),"title",self.archive)
            observed=RELEASE.immutable_upload("test/repo",tag,self.identity["sdk_source_sha"],sorted(directory.iterdir()),"title",self.archive)
        command.assert_called_once()
        self.assertEqual(observed["id"],9)
        self.assertEqual(files,{p.name:p.read_bytes() for p in directory.iterdir()})

    def test_partial_draft_reuses_original_signed_files_and_rejects_extra_asset(self):
        """Resume a subset of the same original candidate inventory; reject unknown assets before upload or edit.
        恢复同一原候选清单的部分资产；上传或公开前拒绝未知资产。
        """
        directory,files=self.original_candidate_fixture()
        tag="v"+self.identity["sdk_version"]
        draft={"id":9,"tag_name":tag,"draft":True,"prerelease":False,"target_commitish":self.identity["sdk_source_sha"]}
        assets={"unrecognized-old-proof.json":{"id":10}}
        with patch.object(RELEASE,"release_by_tag",return_value=draft),patch.object(RELEASE,"resolve_sdk_tag",side_effect=RELEASE.SDKTagMissing("pending exact initial ref")), \
             patch.object(RELEASE,"release_assets",return_value=assets),patch.object(RELEASE,"run") as command,self.assertRaisesRegex(ValueError,"unexpected original evidence"):
            RELEASE.immutable_upload("test/repo",tag,self.identity["sdk_source_sha"],sorted(directory.iterdir()),"title",self.archive)
        command.assert_not_called()
        ordered=sorted(files)
        assets={ordered[0]:{"id":1}}
        state={"public":False}

        def reader(repository,path,binary=False):
            """Read only actual existing/uploaded root bytes or the final published ID.
            仅读取实际既有、已上传根字节或最终公开 ID。
            """
            if path.startswith("releases/assets/"):
                return files[ordered[int(path.split("/")[-1])-1]]
            if path=="releases/9":
                return {**draft,"draft":False,"immutable":False}
            raise AssertionError("Unexpected partial-draft reader route")

        def mutate(arguments):
            """Upload each absent original member once, then publicize only the exact completed inventory.
            每个缺失原成员只上传一次，然后仅公开精确完整清单。
            """
            if arguments[:3]==["gh","release","upload"]:
                name=arguments[4].name
                self.assertFalse(state["public"])
                self.assertNotIn(name,assets)
                assets[name]={"id":ordered.index(name)+1}
            else:
                self.assertEqual(arguments[:3],["gh","release","edit"])
                self.assertEqual(set(assets),set(files))
                state["public"]=True

        with patch.object(RELEASE,"release_by_tag",return_value=draft),patch.object(RELEASE,"resolve_sdk_tag",side_effect=lambda *a:None if state["public"] else (_ for _ in ()).throw(RELEASE.SDKTagMissing("pending exact initial ref"))), \
             patch.object(RELEASE,"release_assets",side_effect=lambda *a:copy.deepcopy(assets)),patch.object(RELEASE,"github_request",side_effect=reader),patch.object(RELEASE,"run",side_effect=mutate) as command:
            RELEASE.immutable_upload("test/repo",tag,self.identity["sdk_source_sha"],sorted(directory.iterdir()),"title",self.archive)
        self.assertEqual(command.call_count,len(files))
        self.assertEqual(files,{p.name:p.read_bytes() for p in directory.iterdir()})

    def test_real_six_example_zip_is_signed_once_and_recovers_identical_bytes(self):
        """Exercise real fixed-six ZIP validation plus public recovery/signature binding, preserving the original source package.
        验证真实固定六例 ZIP 及公共恢复、签名绑定，保留原源码包。
        """
        self.http=RecoveryHttp({})
        self.signatures={}
        proof=self.root/"sdk-proof"
        proof.mkdir()
        consumer={"artifact":self.identity,"success":True,"cache":"new-empty-cache","unit_only":True}
        RELEASE.write_json(proof/"formal-consumer.json",consumer)
        header={"schema_version":2,"sdk_source_sha":self.identity["sdk_source_sha"],"sdk_version":self.identity["sdk_version"],
            "core_tag":self.core_tag,"core_commit":self.identity["core_commit"],"repository":"test/repo","candidate_run_id":"123","candidate_run_attempt":2,
            "completion_run_id":"456","completion_run_attempt":3,"completion_source_sha":self.identity["sdk_source_sha"],"accepted":True,
            "registry_consumer_file":"formal-consumer.json","registry_consumer_sha256":RELEASE.digest(proof/"formal-consumer.json")}
        RELEASE.write_json(proof/"accepted.json",header)
        packager=RELEASE.example_packager()
        package_name="luaskills-sdk-typescript-examples-"+self.identity["sdk_version"]
        staged=self.root/package_name
        packager.stage_package(staged,self.identity["sdk_version"])
        archive=self.root/(package_name+".zip")
        packager.archive_package(staged,archive,self.identity["sdk_version"])
        sidecar=self.root/(archive.name+".sha256")
        sidecar.write_text(RELEASE.digest(archive)+"  "+archive.name+"\n",encoding="utf-8")
        notes=self.root/"example-notes.md"
        notes.write_text("unit-only source examples notes",encoding="utf-8")
        log=self.root/"example-smoke.log"
        log.write_text("unit-only six-example smoke fixture",encoding="utf-8")
        args=SimpleNamespace(core_root=OPTIONS.core_root,repository="test/repo",sdk_proof=proof,archive=archive,sidecar=sidecar,notes=notes,
            smoke_log=log,mode="artifact-only",output=self.root/"examples-candidate")
        self.add_attempt(123,2,[RELEASE.workflow_job_name(RELEASE.EXAMPLES_WORKFLOW,"candidate-evidence")],mode="artifact-only",workflow=RELEASE.EXAMPLES_WORKFLOW)
        with self.recovery_context(),patch.dict(os.environ,self.recovery_environment(workflow=RELEASE.EXAMPLES_WORKFLOW)),contextlib.redirect_stdout(io.StringIO()):
            RELEASE.examples_bundle(args)
        self.fixture_signature(args.output,RELEASE.EXAMPLES_ATTESTATION,123,2,RELEASE.EXAMPLES_WORKFLOW)
        with self.recovery_context(),patch.dict(os.environ,self.recovery_environment(workflow=RELEASE.EXAMPLES_WORKFLOW)):
            RELEASE.examples_seal(SimpleNamespace(core_root=OPTIONS.core_root,input=args.output))
        files={p.name:p.read_bytes() for p in args.output.iterdir()}
        self.register_artifact(files)
        fetch=self.fetch_args("restored-examples")
        with self.recovery_context():
            RELEASE.examples_fetch(fetch)
            state=RELEASE.local_examples(SimpleNamespace(core_root=OPTIONS.core_root,candidate=fetch.output,repository="test/repo"))
        self.assertEqual(state["manifest"]["mode"],"artifact-only")
        self.assertEqual(len(state["manifest"]["examples"]),6)
        self.assertEqual((fetch.output/"original"/archive.name).read_bytes(),archive.read_bytes())
        self.assertEqual(files,{p.name:p.read_bytes() for p in (fetch.output/"original").iterdir()})

    def test_frozen_workflow_orders_signed_candidate_before_all_publication(self):
        """Check named jobs, explicit recovery interfaces and isolated signing/publication privileges from actual frozen source.
        从实际冻结源码检查命名作业、明确恢复接口及隔离签名、发布权限。
        """
        sdk=(ROOT/RELEASE.SDK_WORKFLOW).read_text(encoding="utf-8")
        examples=(ROOT/RELEASE.EXAMPLES_WORKFLOW).read_text(encoding="utf-8")
        self.assertEqual(RELEASE.workflow_job_name(RELEASE.SDK_WORKFLOW,"candidate-evidence"),"candidate-evidence")
        self.assertEqual(RELEASE.workflow_job_name(RELEASE.EXAMPLES_WORKFLOW,"candidate-evidence"),"examples-candidate-evidence")
        for text in (sdk,examples):
            self.assertIn("default: artifact-only",text)
            self.assertIn("environment: production",text)
            self.assertNotIn("--clobber",text)
            self.assertNotIn("--run-id",text)
        self.assertEqual(sdk.count("npm pack "),1)
        self.assertEqual(sdk.count("sdk_release.py publish-or-verify "),1)
        self.assertLess(sdk.index("candidate-seal "),sdk.index("sdk_release.py publish-or-verify "))
        self.assertLess(sdk.index("candidate-fetch "),sdk.index("sdk_release.py publish-or-verify "))
        self.assertLess(examples.index("examples-seal "),examples.index("sdk_release.py publish-examples "))
        self.assertIn("--completion-source-sha",examples)
        self.assertEqual(sdk.count("      actions: read"),2)
        self.assertEqual(examples.count("      actions: read"),2)

    def test_extra_asset_in_initial_final_or_late_draft_never_becomes_valid_release(self):
        """Reject extra root subjects at every actual asset snapshot, before public edit when observable.
        在每个实际资产快照拒绝多余根主体；可观察时在公开变更前拒绝。
        """
        base={self.archive.name:{"id":10}}
        extra={**base,"orphan-proof.json":{"id":11}}
        for phase in ("initial-draft","initial-final","late-draft","final-readback"):
            with self.subTest(phase=phase):
                draft={"id":1,"draft":phase!="initial-final","prerelease":False,"tag_name":"v0.5.7","target_commitish":"a"*40,"immutable":False}
                final={**draft,"draft":False}
                assets=[extra] if phase.startswith("initial") else [base,extra] if phase=="late-draft" else [base,base,extra]
                replies=[self.archive.read_bytes()]
                if phase=="final-readback":
                    replies += [self.archive.read_bytes(),final]
                with patch.object(RELEASE,"release_by_tag",return_value=draft),patch.object(RELEASE,"resolve_sdk_tag"), \
                     patch.object(RELEASE,"release_assets",side_effect=assets),patch.object(RELEASE,"github_request",side_effect=replies), \
                     patch.object(RELEASE,"run") as command,self.assertRaisesRegex(ValueError,"unexpected original evidence|exactly the frozen|different complete asset set"):
                    RELEASE.immutable_upload("test/repo","v0.5.7","a"*40,[self.archive],"title",self.archive)
                if phase=="final-readback":
                    self.assertEqual([call.args[0][2] for call in command.call_args_list],["edit"])
                else:
                    command.assert_not_called()

    def test_wrong_final_tag_rejects_without_success_or_completion_record(self):
        """Require the actual final tag despite valid draft/source/assets, and propagate late failure before completion evidence.
        即使草稿、源码、资产有效也要求实际最终标签匹配，并在完成证据前传播末期失败。
        """
        for tag in ("v0.5.7", "examples-v0.5.7", "recovery-v0.5.7-r456-a3"):
            with self.subTest(tag=tag):
                # The actual Git reference remains correct; only the published Release's physical tag changes.
                # 实际 Git 引用保持正确；仅已公开 Release 的物理标签发生变化。
                draft = {"id": 1, "draft": True, "prerelease": False, "tag_name": tag, "target_commitish": "a" * 40}
                published = {**draft, "draft": False, "tag_name": "different-release-tag", "immutable": False}
                assets = {self.archive.name: {"id": 10}}

                def reader(repository, path, binary=False):
                    """Serve legal exact source/member bytes and the mismatched final ID response; fail all other requests.
                    提供合法精确源码、成员字节及不匹配最终 ID 响应；其他请求一律失败。
                    """
                    if path == "git/ref/tags/" + tag:
                        return {"ref": "refs/tags/" + tag, "object": {"type": "commit", "sha": "a" * 40}}
                    if path == "releases/assets/10":
                        self.assertTrue(binary)
                        return self.archive.read_bytes()
                    if path == "releases/1":
                        return published
                    raise AssertionError("Unexpected final-tag fixture URL: " + path)

                with patch.object(RELEASE, "release_by_tag", return_value=draft), patch.object(RELEASE, "release_assets", return_value=assets), \
                     patch.object(RELEASE, "github_request", side_effect=reader), patch.object(RELEASE, "run") as command, \
                     contextlib.redirect_stdout(io.StringIO()) as output, self.assertRaisesRegex(ValueError, "exact formal release"):
                    RELEASE.immutable_upload("test/repo", tag, "a" * 40, [self.archive], "title", self.archive)
                self.assertEqual(output.getvalue(), "")
                self.assertEqual([call.args[0][2] for call in command.call_args_list], ["edit"])
        # A failed actual main-release readback cannot create the receipt later consumed by completion-bundle.
        # 实际主 Release 回读失败不能创建随后由 completion-bundle 消费的回执。
        consumer = self.root / "consumer.json"
        RELEASE.write_json(consumer, {"artifact": self.identity, "success": True, "cache": "new-empty-cache"})
        args = SimpleNamespace(core_root=OPTIONS.core_root, candidate=self.root, repository="test/repo", intent="recover",
            consumer=consumer, prerequisites=self.prerequisites, output=self.root / "main-release.json")
        with patch.object(RELEASE, "local_candidate", return_value={"root": self.root, "identity": self.identity}), \
             patch.object(RELEASE, "current_completion"), patch.object(RELEASE, "authority", return_value=CORE), \
             patch.object(RELEASE, "immutable_upload", side_effect=ValueError("Draft release did not become the exact formal release")), \
             self.assertRaisesRegex(ValueError, "exact formal release"):
            RELEASE.publish_candidate(args)
        self.assertFalse(args.output.exists())


if __name__ == "__main__":
    unittest.main(argv=[__file__, *TEST_ARGUMENTS])
