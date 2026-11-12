import esbuild from "esbuild";
import { readFileSync } from "node:fs";

const notice = readFileSync("LICENSE", "utf8").trim();
const banner = "/*\n" + notice.replaceAll("*/", "* /") + "\n*/";

const production = process.argv[2] === "production";
const context = await esbuild.context({
  banner: { js: banner },
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
