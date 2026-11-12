// Optional native acceptance. The executable, profile and vault are verified before UI actions.
// Only generated profiles receive copied release artifacts or test settings.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm, realpath } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir, release } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
const { chromium } = createRequire(process.env.RUN_BACKGROUND_PLAYWRIGHT_PACKAGE ?? import.meta.url)('playwright');
const executable = process.env.OBSIDIAN_EXECUTABLE;
const asar = process.env.OBSIDIAN_ASAR;
assert(executable && asar, 'Set OBSIDIAN_EXECUTABLE and OBSIDIAN_ASAR to application code.');
const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
const iconBundle = (await build({ entryPoints: ['src/icon.ts'], bundle: true, platform: 'browser', format: 'iife', globalName: 'RunBackgroundIcons', write: false })).outputFiles[0].text;
const evidence = { platform: process.platform, kernel: release(), obsidian: path.basename(asar), plugin: manifest.version, runs: [] };
const canonical = value => realpath(path.resolve(value));
async function launch(empty) {
  const directory = await mkdtemp(path.join(tmpdir(), 'run-background-native-')), profile = path.join(directory, 'profile'), vault = path.join(directory, 'vault');
  await mkdir(profile); await copyFile(asar, path.join(profile, path.basename(asar)));
  const artifacts = {};
  if (!empty) {
    const plugin = path.join(vault, '.obsidian/plugins', manifest.id); await mkdir(plugin, { recursive: true });
    for (const name of ['main.js', 'manifest.json', 'styles.css']) { const body = await readFile(name); await copyFile(name, path.join(plugin, name)); artifacts[name] = createHash('sha256').update(body).digest('hex'); }
    await writeFile(path.join(vault, 'Synthetic.md'), '# Synthetic\nNo personal data.\n');
    await writeFile(path.join(vault, '.obsidian/community-plugins.json'), JSON.stringify([manifest.id]));
    await writeFile(path.join(profile, 'obsidian.json'), JSON.stringify({ updateDisabled: true, vaults: { '0123456789abcdef': { path: vault, ts: Date.now(), open: true } } }));
  } else await writeFile(path.join(profile, 'obsidian.json'), JSON.stringify({ updateDisabled: true, vaults: {} }));
  const args = [`--user-data-dir=${profile}`, '--remote-debugging-port=0', '--enable-automation', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows'];
  const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; child.stdout.on("data", chunk => { output += String(chunk); }); child.stderr.on("data", chunk => { output += String(chunk); });
  child.on("error", error => { output += error.message; });
  let browser, verified = false;
  const ownedPids = async () => { try { const { stdout } = await promisify(execFile)('pgrep', ['-f', '--', `--user-data-dir=${profile}`]); return stdout.split('\n').filter(Boolean).map(Number); } catch { return []; } };
  const close = async () => {
    if (verified && browser) { const page = browser.contexts()[0].pages()[0]; await page?.evaluate(empty => { const app = window.require('@electron/remote')?.app ?? window.require('electron').remote?.app; if (empty) app.exit(0); else app.quit(); }, empty).catch(() => {}); }
    await browser?.close().catch(() => {});
    for (let i = 0; i < 300 && (await ownedPids()).length; i++) await new Promise(resolve => setTimeout(resolve, 100));
    const orderlyQuit = !empty && verified && !(await ownedPids()).length;
    // Every PID must still carry this exact generated-profile argument before cleanup.
    for (const pid of await ownedPids()) { const { stdout } = await promisify(execFile)('ps', ['-p', String(pid), '-o', 'command=']); if (stdout.includes(`--user-data-dir=${profile}`)) process.kill(pid, 'SIGTERM'); }
    await new Promise(resolve => setTimeout(resolve, 1500));
    for (const pid of await ownedPids()) { const { stdout } = await promisify(execFile)("ps", ["-p", String(pid), "-o", "command="]); if (stdout.includes(`--user-data-dir=${profile}`)) process.kill(pid, "SIGKILL"); }
    await new Promise(resolve => setTimeout(resolve, 300));
    if ((await ownedPids()).length) throw new Error('Generated process did not stop; fixture kept.');
    await rm(directory, { recursive: true, force: true });
    if (!empty && verified) { assert(orderlyQuit, 'Normal Quit did not stop the owned test process.'); evidence.nativeQuitExited = true; }
  };
  try {
    let port;
    for (let i = 0; i < 150; i++) { try { port = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
    assert(port, 'Generated profile did not expose debugging: ' + output);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const context = browser.contexts()[0], page = context.pages()[0] ?? await context.waitForEvent('page');
    const session = await context.newCDPSession(page), command = await session.send('Browser.getBrowserCommandLine');
    assert(command.arguments.includes(`--user-data-dir=${profile}`));
    let executableMatch = false;
    for (const argument of command.arguments) { try { if (await canonical(argument) === await canonical(executable)) executableMatch = true; } catch {} }
    assert(executableMatch, 'Executable mismatch.');
    const bound = await page.evaluate(() => { for (const name of ['@electron/remote', 'electron']) { try { const module = window.require(name), app = module.app ?? module.remote?.app; if (app?.getPath) return app.getPath('userData'); } catch {} } return null; });
    assert.equal(await canonical(bound), await canonical(profile)); verified = true;
    await context.route('**/*', route => { const url = new URL(route.request().url()); return ['app:', 'file:', 'data:', 'blob:', 'devtools:'].includes(url.protocol) || ['127.0.0.1', 'localhost'].includes(url.hostname) ? route.continue() : route.abort('blockedbyclient'); });
    await session.send('Emulation.setFocusEmulationEnabled', { enabled: true }); page.setDefaultTimeout(12000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    if (empty) {
      await page.waitForFunction(() => document.body.classList.contains('starter') && Boolean(document.querySelector('.starter-screen')));
      evidence.runs.push({ kind: 'native chooser identity', url: page.url(), bodyClass: await page.locator('body').getAttribute('class'), starterScreen: true, profileVerified: true });
    } else {
      await page.waitForFunction(() => Boolean(window.app?.vault?.adapter?.getBasePath));
      assert.equal(await canonical(await page.evaluate(() => window.app.vault.adapter.getBasePath())), await canonical(vault));
      await page.getByRole('button', { name: 'Trust author and enable plugins', exact: true }).click();
      await page.waitForFunction(() => window.app?.workspace?.layoutReady);

      await page.waitForFunction(id => Boolean(window.app.plugins.getPlugin(id)?.hasRecoveryTray()) && window.app.plugins.getPlugin(id).commandsRegistered && window.app.plugins.loadingPluginId !== id, manifest.id);
      assert(await page.evaluate(id => { const tabs = window.app.setting.pluginTabs.filter(tab => tab.id === id); return tabs.length === 1 && tabs[0].plugin === window.app.plugins.getPlugin(id); }, manifest.id), 'The native settings tab must belong to the sole loaded plugin instance.');
      const hostProof = await page.evaluate(async id => {
        const plugin = window.app.plugins.getPlugin(id), directory = window.app.plugins.manifests[id].dir, hashes = {};
        for (const name of ['main.js', 'manifest.json', 'styles.css']) hashes[name] = await window.app.vault.adapter.read(directory + '/' + name);
        return { directory, version: plugin.manifest.version, hashes };
      }, manifest.id);
      assert.equal(hostProof.directory, '.obsidian/plugins/' + manifest.id);
      for (const [name, body] of Object.entries(hostProof.hashes)) assert.equal(createHash('sha256').update(body).digest('hex'), artifacts[name]);
      await page.evaluate(async id => { const tab = window.app.setting.pluginTabs.find(tab => tab.id === id); tab.update(); await window.app.setting.open(); window.app.setting.openTabById(id); }, manifest.id);
      let ui;
      for (let attempt = 0; attempt < 100 && !ui; attempt++) {
        for (const candidate of context.pages()) if (await candidate.getByText('Vault badge', { exact: true }).count()) { ui = candidate; break; }
        if (!ui) await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert(ui, 'Settings did not open in the generated native context.'); ui.setDefaultTimeout(12000);
      const uiProfile = await ui.evaluate(() => { for (const name of ['@electron/remote', 'electron']) { try { const module = window.require(name), app = module.app ?? module.remote?.app; if (app?.getPath) return app.getPath('userData'); } catch {} } return null; });
      assert.equal(await canonical(uiProfile), await canonical(profile));
      const uiSession = await context.newCDPSession(ui); await uiSession.send('Emulation.setFocusEmulationEnabled', { enabled: true }); ui.on('pageerror', error => errors.push(error.message));
      const badge = ui.locator('.setting-item').filter({ has: ui.getByText('Vault badge', { exact: true }) }).locator('input[type=text]');
      await badge.focus(); await badge.fill('ßßß');
      await page.waitForFunction(id => !window.app.plugins.getPlugin(id).settingsPending, manifest.id);
      assert.equal(await badge.inputValue(), 'SSS'); assert(await badge.evaluate(el => document.activeElement === el));
      await page.evaluate(id => { const plugin = window.app.plugins.getPlugin(id); plugin.fixtureOriginalSave = plugin.saveData; plugin.saveData = async () => { throw new Error('Synthetic disk-full error'); };  }, manifest.id);
      const quitRow = ui.locator('.setting-item').filter({ has: ui.getByText('Keep running after Quit command', { exact: true }) });
      await quitRow.locator('.checkbox-container').click();
      await ui.getByRole('status').filter({ hasText: 'Synthetic disk-full error' }).waitFor();
      const failedState = await page.evaluate(async id => { const plugin = window.app.plugins.getPlugin(id); return { runtime: plugin.settings.keepRunningAfterQuit, disk: JSON.parse(await window.app.vault.adapter.read(plugin.manifest.dir + '/data.json')).keepRunningAfterQuit }; }, manifest.id);
      assert.equal(failedState.runtime, true); assert.equal(failedState.disk, true);
      await page.evaluate(id => { const plugin = window.app.plugins.getPlugin(id); plugin.saveData = plugin.fixtureOriginalSave; delete plugin.fixtureOriginalSave; }, manifest.id);
      await ui.getByRole('button', { name: 'Retry', exact: true }).click();
      await page.waitForFunction(id => window.app.plugins.getPlugin(id).settings.keepRunningAfterQuit === false && !window.app.plugins.getPlugin(id).settingsPending, manifest.id);
      assert(await ui.getByRole('status').filter({ hasText: 'Settings saved.' }).count());
      const presetButtons = ui.locator('button[data-preset]');
      assert((await presetButtons.count()) >= 2);
      const firstPreset = presetButtons.nth(0), nextPreset = presetButtons.nth(1);
      for (const corner of [{ x: 1, y: 20 }, { x: 39, y: 20 }, { x: 20, y: 1 }, { x: 20, y: 39 }]) { await firstPreset.click({ position: corner }); await page.waitForFunction(id => !window.app.plugins.getPlugin(id).settingsPending, manifest.id); assert.equal(await firstPreset.getAttribute('aria-pressed'), 'true'); assert.equal(await nextPreset.getAttribute('aria-pressed'), 'false'); }
      await nextPreset.click({ position: { x: 1, y: 20 } }); await page.waitForFunction(id => !window.app.plugins.getPlugin(id).settingsPending, manifest.id); assert.equal(await nextPreset.getAttribute('aria-pressed'), 'true'); assert.equal(await firstPreset.getAttribute('aria-pressed'), 'false');
      const measureTargets = () => {
        const controls = [...document.querySelectorAll('.setting-item button,.setting-item input,.setting-item select,.setting-item .checkbox-container')].filter(el => { const rect = el.getBoundingClientRect(); return rect.width && rect.height && !(el.tagName === 'INPUT' && el.closest('.checkbox-container')); });
        return controls.map(el => { const r = el.getBoundingClientRect(), cx = r.x + r.width / 2, cy = r.y + r.height / 2; const spacing = controls.every(other => { if (other === el || other.contains(el) || el.contains(other)) return true; const s = other.getBoundingClientRect(), dx = cx - Math.max(s.left, Math.min(cx, s.right)), dy = cy - Math.max(s.top, Math.min(cy, s.bottom)); return Math.hypot(dx, dy) >= 12 && (!(s.width < 24 || s.height < 24) || Math.hypot(cx - s.x - s.width / 2, cy - s.y - s.height / 2) >= 24); }); return { name: el.getAttribute('aria-label') || el.textContent || el.closest('.setting-item')?.querySelector('.setting-item-name')?.textContent, width: r.width, height: r.height, rule: r.width >= 24 && r.height >= 24 ? 'AA 24px' : spacing ? 'AA spacing exception' : 'FAIL' }; });
      };
      const targets = await ui.evaluate(measureTargets); assert(targets.length > 10 && targets.every(target => target.rule !== 'FAIL'));
      await ui.evaluate(() => { document.body.style.zoom = "2"; });
      await firstPreset.click({ position: { x: 1, y: 20 } }); await page.waitForFunction(id => !window.app.plugins.getPlugin(id).settingsPending, manifest.id); assert.equal(await firstPreset.getAttribute("aria-pressed"), "true");
      const largerTargets = await ui.evaluate(measureTargets); assert(largerTargets.every(target => target.rule !== "FAIL"));
      await firstPreset.focus(); await firstPreset.press("Space");
      await ui.evaluate(() => { document.body.style.zoom = "1"; });
      await page.addScriptTag({ content: iconBundle });
      const representations = await page.evaluate(async () => { const source = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="32"><rect width="64" height="32" fill="#ff0000"/></svg>'); const icon = await RunBackgroundIcons.composeTrayIcon(source, '', '#141418'); return icon.pixmaps.map(({width,height,data}) => ({ width, height, bytes: data.length, center: [...data.slice((Math.floor(height/2)*width+Math.floor(width/2))*4,(Math.floor(height/2)*width+Math.floor(width/2))*4+4)], margin: [...data.slice(0,4)] })); });
      assert.deepEqual(representations.map(item => [item.width,item.height,item.bytes]), [[16,16,1024],[32,32,4096]]); for (const item of representations) { assert.deepEqual(item.center,[255,255,0,0]); assert.deepEqual(item.margin,[0,0,0,0]); }
      const pixels = await page.evaluate(async id => {
        const plugin = window.app.plugins.getPlugin(id);
        const source = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="256" height="128"><rect width="256" height="128" fill="#ff0000"/></svg>');
        await plugin.requestSetting('trayIconImage', source); await plugin.requestSetting('vaultBadge', '');
        const saved = plugin.settings.trayIconImage;
        const image = new Image(); image.src = saved; await image.decode();
        const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 64; const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
        const center = [...ctx.getImageData(32, 32, 1, 1).data], margin = [...ctx.getImageData(32, 0, 1, 1).data];
        const preview = new Image(); preview.src = plugin.trayPreviewDataUrl; await preview.decode();
        let remoteRejected = false, oversizedRejected = false, dimensionsRejected = false;
        for (const [value, kind] of [['https://example.test/icon.png', 'remote'], ['data:image/svg+xml,' + 'x'.repeat(600000), 'bytes'], ['data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="4096" height="4096"/>'), 'dimensions']]) {
          try { await plugin.requestSetting('trayIconImage', value); } catch { if (kind === 'remote') remoteRejected = true; else if (kind === 'bytes') oversizedRejected = true; else dimensionsRejected = true; }
        }
        return { savedBytes: saved.length, dimensions: [image.naturalWidth, image.naturalHeight], center, margin, previewDimensions: [preview.naturalWidth, preview.naturalHeight], remoteRejected, oversizedRejected, dimensionsRejected, savedPreserved: plugin.settings.trayIconImage === saved, recovery: plugin.hasRecoveryTray() };
      }, manifest.id);
      assert.deepEqual(pixels.dimensions, [64, 64]); assert.deepEqual(pixels.center, [255, 0, 0, 255]); assert.equal(pixels.margin[3], 0); assert.deepEqual(pixels.previewDimensions, [128, 128]); assert(pixels.savedBytes < 65536 && pixels.remoteRejected && pixels.oversizedRejected && pixels.dimensionsRejected && pixels.savedPreserved && pixels.recovery);
      await ui.screenshot({ path: '/private/tmp/run-background-native-settings.png' });
      const ordinaryClose = await page.evaluate(() => { const current = window.require('electron').remote.getCurrentWindow(); current.close(); return !current.isDestroyed() && !current.isVisible() && current.closing !== true; });
      assert(ordinaryClose, 'The real close guard must keep the synthetic vault alive and hidden.');
      await page.evaluate(id => window.app.plugins.getPlugin(id).showWindows(), manifest.id);
      evidence.runs.push({ kind: 'built plugin settings/icon', profileVerified: true, vaultVerified: true, artifacts, focusPreserved: true, badge: 'SSS', pixels, representations, targets, largerTargets, edgeAndAdjacentClicks: true, nativeSaveFailureAndRetry: true, soleSettingTabOwner: true, ordinaryCloseCancelled: true, errors });
      assert.deepEqual(errors, []);
    }
    return close;
  } catch (error) { if (verified && browser) { const page = browser.contexts()[0].pages()[0]; await page?.screenshot({ path: '/private/tmp/run-background-native-failed.png' }).catch(() => {}); await writeFile('/private/tmp/run-background-native-failed.txt', await page?.locator('body').innerText().catch(() => '') ?? ''); } await close(); throw error; }
}
for (const empty of (process.argv.includes("--vault-only") ? [false] : [true, false])) { const close = await launch(empty); await writeFile('/private/tmp/run-background-native-evidence.json', JSON.stringify(evidence, null, 2)); await close(); }
await writeFile('/private/tmp/run-background-native-evidence.json', JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence, null, 2));
