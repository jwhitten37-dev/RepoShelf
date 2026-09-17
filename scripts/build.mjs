import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");
const options = {
  bundle: true,
  entryPoints: ["src/extension.ts"],
  external: ["vscode"],
  format: "cjs",
  logLevel: "info",
  minify: false,
  outfile: "dist/extension.js",
  platform: "node",
  sourcemap: true,
  target: "node24",
};

if (watch) {
  const context = await esbuild.context(options);
  await context.watch();
  console.log("Watching extension sources...");
} else {
  await esbuild.build(options);
}
