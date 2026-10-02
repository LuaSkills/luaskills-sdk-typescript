"""Verify actual standalone ZIP bytes and deliberate release-boundary failures.
验证真实独立 ZIP 字节及故意触发的发布边界失败。
"""

import json
import os
import runpy
import tempfile
import unittest
import zipfile
from pathlib import Path

# Load the actual workflow implementation without invoking its CLI or any release operation.
# 加载真实工作流实现，不调用其 CLI 或任何发布操作。
PACKAGING = runpy.run_path(str(Path(__file__).resolve().parent.parent / "scripts/package-standalone-examples.py"))


class StandaloneExamplesPackageTest(unittest.TestCase):
    """Exercise real ZIP output using the same manifest consumed by the release workflow.
    使用发布工作流消费的同一清单验证真实 ZIP 输出。
    """

    def setUp(self):
        """Create a fresh source package using the checkout's actual VERSION.
        使用检出实际 VERSION 创建新的源码包。
        Returns after staging only local files; installs nothing.
        仅暂存本地文件后返回；不安装任何内容。
        """
        self.temporary = tempfile.TemporaryDirectory(prefix="luaskills-standalone-zip-")
        self.addCleanup(self.temporary.cleanup)
        self.version = (PACKAGING["SOURCE_ROOT"] / "VERSION").read_text().strip()
        self.root = Path(self.temporary.name) / f"luaskills-sdk-typescript-examples-{self.version}"
        self.archive = Path(self.temporary.name) / "examples.zip"
        PACKAGING["stage_package"](self.root, self.version)

    def test_actual_zip_selects_all_released_examples_and_valid_links(self):
        """Inspect real ZIP bytes, excluding development and installed artifacts.
        检查真实 ZIP 字节，排除开发及已安装产物。
        Returns after every manifest example, exact package version and documentation link is verified.
        清单内每个示例、精确包版本及文档链接均获验证后返回。
        """
        # Mimic files introduced by published-package smoke preparation.
        # 模拟已发布包冒烟准备引入的文件。
        installed = self.root / "node_modules/@luaskills/sdk/dist/index.js"
        installed.parent.mkdir(parents=True)
        installed.write_text("installed SDK")
        (self.root / "examples/embedded-candidate.mjs").write_text("development entry")
        (self.root / "examples/fixture-runtime/downloaded.dll").write_text("installed runtime")
        # Selection must remain exactly the manifest even after those files exist in the staging root.
        # 即使暂存根存在这些文件，选择仍必须精确保持清单。
        names = PACKAGING["archive_package"](self.root, self.archive, self.version)
        self.assertEqual(len(names), 6, "Published example selection may have changed; review the legacy release boundary")
        self.assertEqual(names, [entry["name"] for entry in PACKAGING["release_manifest"]()["examples"]])
        with zipfile.ZipFile(self.archive) as zipped:
            # Real archive members and bytes are inspected rather than source text patterns.
            # 检查真实归档成员及字节，而非源码文本模式。
            members = zipped.namelist()
            for name in names:
                self.assertEqual(zipped.read(f"{self.root.name}/examples/{name}.mjs"), (self.root / f"examples/{name}.mjs").read_bytes())
            self.assertFalse(any("embedded-candidate" in member or "node_modules" in member or "downloaded.dll" in member for member in members))
            self.assertEqual(json.loads(zipped.read(f"{self.root.name}/package.json"))["dependencies"], {"@luaskills/sdk": self.version})

    def test_missing_example_is_rejected_in_real_archive(self):
        """Remove a selected example from ZIP bytes and require explicit missing-member failure.
        从 ZIP 字节移除选定示例，要求显式缺失成员失败。
        Returns after rejecting the incomplete archive.
        拒绝不完整归档后返回。
        """
        self.rewrite_archive(remove=f"examples/{PACKAGING['release_manifest']()['examples'][0]['name']}.mjs")
        with self.assertRaisesRegex(ValueError, "missing=.*examples/"):
            PACKAGING["verify_archive"](self.archive, self.root.name, self.version)

    def test_same_members_reproduce_exact_zip_after_metadata_changes(self):
        """Keep real ZIP bytes identical when source mtimes/modes or a new staging directory differ.
        源文件时间、权限或新暂存目录不同时，真实 ZIP 字节仍完全相同。
        """
        PACKAGING["archive_package"](self.root, self.archive, self.version)
        original = self.archive.read_bytes()
        for name in PACKAGING["member_files"](PACKAGING["release_manifest"]()):
            os.utime(self.root / name, (2000000000, 2000000000))
            os.chmod(self.root / name, 0o600)
        second = self.archive.with_name("metadata-changed.zip")
        PACKAGING["archive_package"](self.root, second, self.version)
        self.assertEqual(second.read_bytes(), original)
        fresh = Path(self.temporary.name) / "fresh" / self.root.name
        PACKAGING["stage_package"](fresh, self.version)
        third = self.archive.with_name("fresh-staging.zip")
        PACKAGING["archive_package"](fresh, third, self.version)
        self.assertEqual(third.read_bytes(), original)
        with zipfile.ZipFile(third) as zipped:
            self.assertTrue(all(member.date_time == PACKAGING["ZIP_TIMESTAMP"] and member.compress_type == zipfile.ZIP_STORED
                                and member.create_system == 3 and member.external_attr == 0o100644 << 16 for member in zipped.infolist()))

    def test_development_entry_is_rejected_in_real_archive(self):
        """Insert a development-only member and require explicit unexpected-member failure.
        插入仅开发成员，要求显式意外成员失败。
        Returns after rejecting the mixed-release archive.
        拒绝混合发布归档后返回。
        """
        self.rewrite_archive(extra="examples/embedded-candidate.mjs")
        with self.assertRaisesRegex(ValueError, "unexpected=.*embedded-candidate"):
            PACKAGING["verify_archive"](self.archive, self.root.name, self.version)

    def test_broken_documentation_link_is_rejected_in_real_archive(self):
        """Insert a missing local Markdown target and reject the actual archive.
        插入缺失本地 Markdown 目标并拒绝实际归档。
        Returns after detecting the concrete broken link.
        检测到具体断链后返回。
        """
        self.rewrite_archive(broken_link=True)
        with self.assertRaisesRegex(ValueError, "broken documentation link.*missing.mjs"):
            PACKAGING["verify_archive"](self.archive, self.root.name, self.version)

    def rewrite_archive(self, remove=None, extra=None, broken_link=False):
        """Create deliberately altered ZIP bytes using the production manifest's exact member list.
        使用生产清单精确成员列表创建故意修改的 ZIP 字节。
        remove/extra/broken_link select one defect; returns after writing the actual archive.
        remove、extra、broken_link 选择一个缺陷；写入实际归档后返回。
        """
        with zipfile.ZipFile(self.archive, "w") as zipped:
            for name in PACKAGING["member_files"](PACKAGING["release_manifest"]()):
                if name == remove:
                    continue
                # Mutations alter archived documentation bytes without changing the source checkout.
                # 变更修改归档文档字节，不改变源码检出。
                data = (self.root / name).read_bytes()
                if broken_link and name == "README.md":
                    data += b"\n[missing](examples/missing.mjs)\n"
                zipped.writestr(f"{self.root.name}/{name}", data)
            if extra is not None:
                zipped.writestr(f"{self.root.name}/{extra}", "development entry")


if __name__ == "__main__":
    unittest.main()
