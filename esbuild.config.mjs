import esbuild from "esbuild";

const production = process.argv[2] === "production";
const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", "@codemirror/state", "@codemirror/view"],
  format: "cjs",
  target: "es2022",
  platform: "node",
  outfile: "main.js",
  sourcemap: production ? false : "inline",
  minify: production,
  logLevel: "info"
});

if (production) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
