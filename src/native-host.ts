import type { ElectronRemote } from './types';

const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && (typeof value === 'object' || typeof value === 'function');
const methods = (value: unknown, names: readonly string[]): boolean => object(value) && names.every(name => typeof value[name] === 'function');

/** A capability check runs before any private host interception. */
export function resolveNativeHost(requireModule: (name: string) => unknown): { remote?: ElectronRemote; error?: string } {
  for (const name of ['electron', '@electron/remote']) {
    try {
      const module = requireModule(name);
      const candidate = object(module) ? module.remote ?? module : undefined;
      if (!object(candidate)
        || !methods(candidate, ['getCurrentWindow', 'require'])
        || !methods(candidate.app, ['on', 'removeListener', 'prependListener', 'getName', 'getPath', 'relaunch', 'quit', 'getLoginItemSettings', 'setLoginItemSettings'])
        || !methods(candidate.BrowserWindow, ['getAllWindows'])
        || !methods(candidate.nativeImage, ['createEmpty'])
        || !methods(candidate.Menu, ['buildFromTemplate'])
        || typeof candidate.Tray !== 'function') continue;
      const vm = (candidate.require as (name: string) => unknown)('vm');
      if (!methods(vm, ['runInThisContext'])) continue;
      return { remote: candidate as unknown as ElectronRemote };
    } catch { /* An unavailable bridge is a supported failure, not partial activation. */ }
  }
  return { error: 'This Obsidian host does not provide the required desktop lifecycle adapter. Vaults remain visible and close normally.' };
}

export function compileNativeFunction<T>(remote: ElectronRemote, fn: T): T {
  const compiled = remote.require('vm').runInThisContext(`(${String(fn)})`) as unknown;
  if (typeof compiled !== 'function') throw new Error('The native lifecycle adapter could not be installed.');
  return compiled as T;
}
