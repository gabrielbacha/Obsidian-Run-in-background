import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface LoginVaultRecord {
  vaultPath: string;
  vaultName: string;
  openAsHidden: boolean;
}

/**
 * The macOS and Windows login item belongs to the whole Obsidian app, but each vault has its own
 * "Launch on startup" setting. Each vault keeps one marker here, and the login item stays on while any
 * existing vault wants it, so a vault that does not want it can no longer turn it off for the others.
 */
export class LoginVaultRegistry {
  private readonly markerPath: string;

  constructor(
    private readonly directory: string,
    private readonly record: Omit<LoginVaultRecord, "openAsHidden">,
  ) {
    const vaultId = createHash("sha256").update(record.vaultPath).digest("hex").slice(0, 20);
    this.markerPath = join(directory, `${vaultId}.json`);
  }

  /** Records this vault's wish and returns every vault that still wants to launch at login. */
  async setWanted(wanted: boolean, openAsHidden: boolean): Promise<LoginVaultRecord[]> {
    await mkdir(this.directory, { recursive: true });
    if (wanted) {
      const temporary = `${this.markerPath}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify({ ...this.record, openAsHidden }), { mode: 0o600 });
      await rename(temporary, this.markerPath);
    } else {
      await rm(this.markerPath, { force: true });
    }
    return this.readWanted();
  }

  private async readWanted(): Promise<LoginVaultRecord[]> {
    const records: LoginVaultRecord[] = [];
    for (const file of await readdir(this.directory)) {
      if (!file.endsWith(".json")) continue;
      try {
        const value = JSON.parse(await readFile(join(this.directory, file), "utf8")) as Partial<LoginVaultRecord>;
        if (typeof value.vaultPath !== "string" || typeof value.vaultName !== "string") continue;
        // A deleted or moved vault cannot withdraw its marker, so it must not keep the login item on.
        await access(value.vaultPath);
        records.push({ vaultPath: value.vaultPath, vaultName: value.vaultName, openAsHidden: value.openAsHidden === true });
      } catch {
        // Unreadable markers and markers of missing vaults do not count.
      }
    }
    return records.sort((left, right) => left.vaultPath.localeCompare(right.vaultPath));
  }
}
