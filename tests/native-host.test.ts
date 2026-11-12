import { describe, expect, it } from 'vitest';
import { resolveNativeHost } from '../src/native-host';
import { launchDiagnostic } from '../src/lifecycle';

describe('native boundary and private launch diagnostics', () => {
  it('fails closed before using an unknown bridge', () => {
    const result = resolveNativeHost(() => ({ remote: { app: {} } }));
    expect(result.remote).toBeUndefined();
    expect(result.error).toContain('close normally');
    expect(resolveNativeHost(() => { throw new Error('private module path'); }).error).not.toContain('private module path');
  });
  it('does not record CLI values, private URIs, or paths', () => {
    const value = launchDiagnostic(['/private/executable', 'eval', 'code=private-text', 'obsidian://open?file=private-note']);
    expect(value).toEqual({ kind: 'directed', argumentCount: 3 });
    expect(JSON.stringify(value)).not.toContain('private');
  });
});
