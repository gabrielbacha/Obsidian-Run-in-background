import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

interface LockOwner { pid: number; token: string }
export function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/** One lock covers marker changes, the aggregate read and the OS update across renderers. */
export async function withRegistryLock<T>(directory: string, action: () => Promise<T>, timeoutMs = 70_000): Promise<T> {
  await mkdir(directory, { recursive: true });
  const lockPath = join(directory, ".registration-lock"), ownerPath = join(lockPath, "owner.json");
  const owner: LockOwner = { pid: process.pid, token: randomUUID() };
  const readOwner = async (): Promise<LockOwner | undefined> => {
    try { const value = JSON.parse(await readFile(ownerPath, "utf8")) as Partial<LockOwner>; return Number.isSafeInteger(value.pid) && Number(value.pid) > 0 && typeof value.token === "string" ? value as LockOwner : undefined; } catch { return undefined; }
  };
  const started = Date.now();
  while (true) {
    try {
      await mkdir(lockPath);
      try {
        await writeFile(ownerPath, JSON.stringify(owner), { flag: "wx", mode: 0o600 });
        if ((await readOwner())?.token !== owner.token) throw new Error("Startup registration lock changed before use.");
        break;
      } catch (error) {
        if ((await readOwner())?.token === owner.token) await rm(lockPath, { recursive: true, force: true });
        throw error;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const current = await readOwner();
      const information = await stat(lockPath).catch(() => undefined);
      const incomplete = !current && information !== undefined && Date.now() - information.mtimeMs > 30_000;
      if ((current && !processIsAlive(current.pid)) || incomplete) {
        // Serialize stale removal too. A second remover must inspect the new owner,
        // rather than deleting a live replacement after the first remover released it.
        const reaper = join(directory, ".registration-reaper");
        let claimed = false;
        try { await mkdir(reaper); claimed = true; }
        catch (failure) { if ((failure as NodeJS.ErrnoException).code !== "EEXIST") throw failure; }
        if (claimed) {
          try {
            const checked = await readOwner(), latest = await stat(lockPath).catch(() => undefined);
            if ((checked && !processIsAlive(checked.pid)) || (!checked && latest && Date.now() - latest.mtimeMs > 30_000)) await rm(lockPath, { recursive: true, force: true });
          } finally { await rm(reaper, { recursive: true, force: true }); }
          continue;
        }
      }
      if (Date.now() - started >= timeoutMs) throw new Error("Another vault is still updating startup registration. The prior state was kept; retry shortly.");
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  }
  try { return await action(); }
  finally { if ((await readOwner())?.token === owner.token) await rm(lockPath, { recursive: true, force: true }); }
}
