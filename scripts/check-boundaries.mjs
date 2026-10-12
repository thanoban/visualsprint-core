import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
async function walk(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (["node_modules", "dist", ".turbo"].includes(entry.name)) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(file);
      continue;
    }
    if (!/\.[cm]?[jt]sx?$/.test(file)) continue;
    const relative = path.relative(root, file).replaceAll("\\", "/");
    const source = await readFile(file, "utf8");
    const owner = relative.match(/^services\/([^/]+)\//)?.[1];
    const imports = [
      ...source.matchAll(/(?:from\s*|import\s*\(|import\s+|require\s*\()\s*["']([^"']+)["']/g),
    ];
    for (const [, specifier] of imports) {
      const resolved = specifier.startsWith(".")
        ? path.relative(root, path.resolve(path.dirname(file), specifier)).replaceAll("\\", "/")
        : specifier;
      const service = resolved.match(/^services\/([^/]+)\//)?.[1];
      if (service && (service !== owner || relative.startsWith("packages/"))) {
        failures.push(`${relative}: cross-service import ${specifier}`);
      }
      if (
        relative.includes("/src/domain/") &&
        !(
          specifier.startsWith("node:") ||
          specifier === "@visualsprint/contracts" ||
          (specifier.startsWith(".") && resolved.startsWith(`services/${owner}/src/domain/`))
        )
      ) {
        failures.push(`${relative}: domain depends on non-domain code ${specifier}`);
      }
    }
  }
}
await walk(path.join(root, "services"));
await walk(path.join(root, "packages"));
await walk(path.join(root, "apps"));
// Service package names are never valid dependencies of another package. This
// closes the package-alias route around relative-import boundary checks.
const services = await readdir(path.join(root, "services"));
const serviceNames = new Set(
  await Promise.all(
    services.map(
      async (service) =>
        JSON.parse(await readFile(path.join(root, "services", service, "package.json"), "utf8"))
          .name,
    ),
  ),
);
for (const group of ["services", "packages", "apps"]) {
  for (const item of await readdir(path.join(root, group))) {
    const manifest = JSON.parse(
      await readFile(path.join(root, group, item, "package.json"), "utf8"),
    );
    for (const dependency of Object.keys({
      ...manifest.dependencies,
      ...manifest.devDependencies,
    })) {
      if (serviceNames.has(dependency))
        failures.push(`${manifest.name}: forbidden service dependency ${dependency}`);
    }
  }
}
if (failures.length) {
  process.stderr.write(failures.join("\n") + "\n");
  process.exitCode = 1;
} else process.stdout.write("Service import boundaries passed.\n");
