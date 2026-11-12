import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const versions = JSON.parse(readFileSync("versions.json", "utf8"));
const errors = [];
if (manifest.id !== "run-in-background") errors.push("manifest id must remain run-in-background");
if (manifest.version !== packageJson.version) errors.push("manifest and package versions differ");
if (versions[manifest.version] !== manifest.minAppVersion) errors.push("versions.json does not match manifest");
if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) errors.push("version must be x.y.z");
const tagIndex = process.argv.indexOf("--tag");
const tag = tagIndex >= 0 ? process.argv[tagIndex + 1] : process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : undefined;
if (tagIndex >= 0 && !tag) errors.push("--tag requires the release tag");
if (tag !== undefined && tag !== manifest.version) errors.push("release tag must exactly match manifest.version");
for (const file of ["main.js", "manifest.json", "styles.css", "README.md", "LICENSE"]) {
	if (!existsSync(file)) errors.push("missing release/repository file: " + file);
}
if (existsSync("main.js") && existsSync("LICENSE")) {
	const artifact = readFileSync("main.js", "utf8");
	const notice = readFileSync("LICENSE", "utf8").trim().replaceAll("*/", "* /");
	if (!artifact.includes(notice)) errors.push("distributed main.js is missing its complete license notice");
	const syntax = spawnSync(process.execPath, ["--check", "main.js"], { encoding: "utf8" });
	if (syntax.status !== 0) errors.push("distributed main.js is not valid JavaScript");
}
if (errors.length) { for (const error of errors) console.error("- " + error); process.exit(1); }
console.log("Release " + manifest.version + " is valid.");
