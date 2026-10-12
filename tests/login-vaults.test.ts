import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LoginVaultRegistry } from "../src/login-vaults";

let root = "";
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

async function setup() {
  root = await mkdtemp(join(tmpdir(), "rib-login-"));
  const markers = join(root, "markers");
  const vault = async (name: string) => {
    const vaultPath = join(root, name);
    await mkdir(vaultPath);
    return new LoginVaultRegistry(markers, { vaultPath, vaultName: name });
  };
  return { markers, vault };
}

describe("LoginVaultRegistry", () => {
  it("keeps the login item while any vault wants it, whatever order vaults load in", async () => {
    const { vault } = await setup();
    const work = await vault("Work");
    const notes = await vault("Notes");
    const disabled = await vault("Disabled");

    expect((await work.setWanted(true, true)).map((record) => record.vaultName)).toEqual(["Work"]);
    // A vault that does not want launch at login, loading later, withdraws only its own wish.
    expect(await notes.setWanted(false, false)).toHaveLength(1);
    expect(await disabled.setWanted(false, false)).toHaveLength(1);

    const both = await notes.setWanted(true, false);
    expect(both.map((record) => [record.vaultName, record.openAsHidden])).toEqual([
      ["Notes", false],
      ["Work", true],
    ]);
    await work.setWanted(false, false);
    expect(await notes.setWanted(false, false)).toEqual([]);
  });

  it("ignores markers of deleted vaults and unreadable markers", async () => {
    const { markers, vault } = await setup();
    const gone = await vault("Gone");
    await gone.setWanted(true, false);
    await rm(join(root, "Gone"), { recursive: true });
    await writeFile(join(markers, "broken.json"), "{");
    const kept = await vault("Kept");
    expect((await kept.setWanted(false, false))).toEqual([]);
  });
});
