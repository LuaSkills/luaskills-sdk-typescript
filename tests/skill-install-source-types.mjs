import assert from "node:assert/strict";
import { SkillInstallSourceType } from "../dist/index.js";

// Expected managed skill install source protocol values exported by Rust.
// Rust 导出的受管理 skill 安装来源协议值。
const expectedValues = {
  Github: "github",
  OfficialHub: "official_hub",
  Url: "url",
  PrivateUrlManifest: "private_url_manifest",
};

assert.equal(SkillInstallSourceType.Github, expectedValues.Github);
assert.equal(SkillInstallSourceType.OfficialHub, expectedValues.OfficialHub);
assert.equal(SkillInstallSourceType.Url, expectedValues.Url);
assert.equal(SkillInstallSourceType.PrivateUrlManifest, expectedValues.PrivateUrlManifest);
