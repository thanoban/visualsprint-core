import { build } from "esbuild";
import { existsSync } from "node:fs";
import path from "node:path";
// Bundle only our technical workspace packages. External runtime dependencies
// remain service-local and use their normal Node resolution/native packaging.
const externalPackages = {
  name: "external-vendors",
  setup(builder) {
    builder.onResolve({ filter: /^[^./]/ }, (args) =>
      args.kind === "entry-point" ||
      path.isAbsolute(args.path) ||
      args.path.startsWith("@visualsprint/")
        ? undefined
        : { path: args.path, external: true },
    );
  },
};
const entryPoints = Object.fromEntries(
  ["main", "migrate", "worker", "events"]
    .filter((name) => existsSync(`src/${name}.ts`))
    .map((name) => [name, path.resolve(`src/${name}.ts`)]),
);
if (Object.keys(entryPoints).length)
  await build({
    entryPoints,
    outdir: "dist",
    outExtension: { ".js": ".mjs" },
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    sourcemap: true,
    plugins: [externalPackages],
  });
