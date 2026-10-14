import { readdirSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
const root = fileURLToPath(new URL(".", import.meta.url));
const compiler = process.env.BICEP_BIN;
if (!compiler) throw new Error("BICEP_BIN_REQUIRED_NO_AUTO_INSTALL");
function run(binary, args) {
  const result = spawnSync(binary, args, { encoding: "utf8", windowsHide: true, timeout: 120000 });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) throw new Error("LOCAL_VERIFICATION_COMMAND_FAILED");
  return result.stdout;
}
if (!/Bicep CLI version 0\.48\.1\b/.test(run(resolve(compiler), ["--version"])))
  throw new Error("BICEP_VERSION_MUST_BE_0_48_1");
mkdirSync(join(root, "out"), { recursive: true });
for (const directory of [root, join(root, "modules")])
  for (const file of readdirSync(directory).filter((x) => x.endsWith(".bicep")))
    run(resolve(compiler), [
      "build",
      join(directory, file),
      "--outfile",
      join(root, "out", file.replace(/\.bicep$/, ".json")),
    ]);
run(process.execPath, ["--test", join(root, "test/parameters.test.mjs")]);
run(process.execPath, [
  join(root, "validate-parameters.mjs"),
  join(root, "parameters/staging.example.json"),
]);
console.log("LOCAL_SOURCE_VALIDATION_COMPLETE_NO_DEPLOYMENT");
