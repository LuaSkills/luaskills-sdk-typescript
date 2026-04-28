import { LuaSkillsClient } from "@luaskills/sdk";
import { resolve } from "node:path";

const runtimeRoot = process.env.LUASKILLS_RUNTIME_ROOT ?? resolve("luaskills-runtime");
const options = process.env.LUASKILLS_LIB
  ? { libraryPath: process.env.LUASKILLS_LIB, runtimeRoot }
  : { runtimeRoot };
const version = LuaSkillsClient.version(options);

console.log(version);
