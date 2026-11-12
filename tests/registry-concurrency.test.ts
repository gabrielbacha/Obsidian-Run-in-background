import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { build } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";
import { LoginVaultRegistry } from "../src/login-vaults";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function root(): Promise<string> { const directory = await mkdtemp(join(tmpdir(), "rib-processes-")); roots.push(directory); return directory; }
function run(script: string, args: string[]): Promise<void> { return new Promise((resolve, reject) => { const child = spawn(process.execPath, [script, ...args]); let error = ""; child.stderr.on("data", chunk => { error += String(chunk); }); child.on("error", reject); child.on("exit", code => { if (code === 0) resolve(); else reject(new Error(error || `Child exited ${code}`)); }); }); }
describe("registration transactions", () => {
  it.each([false, true])("serializes two actual processes, including stale-owner recovery (%s)", async stale => {
    const directory = await root(), markers = join(directory, "markers"), output = join(directory, "os.json");
    await Promise.all(["a", "b"].map(name => mkdir(join(directory, name))));
    const result = await build({ stdin: { contents: `import { LoginVaultRegistry } from ${JSON.stringify(join(process.cwd(), "src/login-vaults.ts"))}; import { writeFile } from 'node:fs/promises'; const [markers,vault,output]=process.argv.slice(2); await new LoginVaultRegistry(markers,{vaultPath:vault,vaultName:'Same name'}).reconcile(true,false,async(records)=>{await new Promise(r=>setTimeout(r,75));await writeFile(output,JSON.stringify(records));});`, resolveDir: process.cwd() }, bundle: true, format: "esm", platform: "node", write: false });
    const script = join(directory, "child.mjs"); await writeFile(script, result.outputFiles[0]!.text);
    if (stale) {
      const dead = spawn(process.execPath, ["-e", ""]); await new Promise<void>(resolve => dead.once("exit", () => resolve()));
      const lock = join(markers, ".registration-lock"); await mkdir(lock, { recursive: true }); await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: dead.pid, token: "dead-owner" }));
    }
    await Promise.all(["a", "b"].map(name => run(script, [markers, join(directory, name), output])));
    expect((JSON.parse(await readFile(output, "utf8")) as { vaultPath: string }[]).map(record => record.vaultPath)).toEqual([join(directory, "a"), join(directory, "b")]);
    await expect(readFile(join(markers, ".registration-lock/owner.json"))).rejects.toThrow();
  });
  it("allows only one of two actual renderers to claim a shared main-process bootstrap session", async () => {
    const directory = await root();
    const result = await build({ stdin: { contents: `import { LinuxAutostartManager } from ${JSON.stringify(join(process.cwd(), "src/linux-autostart.ts"))}; import { writeFile } from 'node:fs/promises'; (async()=>{const [home,pid]=process.argv.slice(2); const manager=new LinuxAutostartManager(home+'/vault','Same',{home,env:{},executable:'/bin/sh'}); const claimed=await manager.claimStartupBootstrap({pid:Number(pid),sessionId:'synthetic-session',loginLaunch:true}); await writeFile(home+'/'+process.pid+'.claim.json',JSON.stringify(claimed));})().catch(error=>{console.error(error);process.exitCode=1;});`, resolveDir: process.cwd() }, bundle: true, format: "cjs", platform: "node", write: false });
    const script = join(directory, "claim.cjs"); await writeFile(script, result.outputFiles[0]!.text);
    await Promise.all([run(script, [directory, String(process.pid)]), run(script, [directory, String(process.pid)])]);
    const claims = await Promise.all((await readdir(directory)).filter(file => file.endsWith(".claim.json")).map(file => readFile(join(directory, file), "utf8")));
    expect(claims.sort()).toEqual(["false", "true"]);
  });
  it("restores the exact prior marker after failed enable and failed disable", async () => {
    const directory = await root(), vault = join(directory, "vault"); await mkdir(vault);
    const registry = new LoginVaultRegistry(join(directory, "markers"), { vaultPath: vault, vaultName: "Vault" });
    await expect(registry.reconcile(true, true, () => Promise.reject(new Error("OS refused")))).rejects.toThrow("OS refused");
    expect(await registry.setWanted(false, false)).toEqual([]);
    await registry.setWanted(true, true);
    await expect(registry.reconcile(false, false, () => Promise.reject(new Error("OS refused")))).rejects.toThrow("OS refused");
    expect(await registry.setWanted(true, true)).toEqual([{ vaultPath: vault, vaultName: "Vault", openAsHidden: true }]);
  });
  it("keeps a same-vault reload behind pending OS work", async () => {
    const directory = await root(), vault = join(directory, "vault"); await mkdir(vault);
    const old = new LoginVaultRegistry(join(directory, "markers"), { vaultPath: vault, vaultName: "Vault" });
    let finish!: () => void, started!: () => void; const begin = new Promise<void>(resolve => { started = resolve; });
    const saving = old.reconcile(true, true, () => { started(); return new Promise<void>(resolve => { finish = resolve; }); }); await begin;
    const reload = new LoginVaultRegistry(join(directory, "markers"), { vaultPath: vault, vaultName: "Vault" });
    let applied = false; const withdrawing = reload.reconcile(false, false, () => { applied = true; return Promise.resolve(); });
    await new Promise(resolve => setTimeout(resolve, 30)); expect(applied).toBe(false); finish(); await saving; expect(await withdrawing).toEqual([]);
  });
});
