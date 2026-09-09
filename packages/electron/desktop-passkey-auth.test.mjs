import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import {
  authenticateWithDesktopPasskey,
  cancelDesktopPasskeyAuthentication,
  fetchDesktopPasskeyStatus,
  resolveDesktopPasskeyOrigin,
} from './desktop-passkey-auth.mjs';

describe('resolveDesktopPasskeyOrigin', () => {
  test('keeps trusted HTTPS origins exact', () => {
    expect(resolveDesktopPasskeyOrigin('https://remote.example:8443/path')).toBe('https://remote.example:8443');
  });

  test('uses localhost for the embedded loopback server', () => {
    expect(resolveDesktopPasskeyOrigin('http://127.0.0.1:57123/path', { localRuntime: true })).toBe('http://localhost:57123');
    expect(resolveDesktopPasskeyOrigin('http://[::1]:57123/path', { localRuntime: true })).toBe('http://localhost:57123');
    expect(resolveDesktopPasskeyOrigin('http://192.168.1.20:57123/path', { localRuntime: true })).toBe('http://localhost:57123');
  });

  test('allows localhost HTTP and rejects other insecure hosts', () => {
    expect(resolveDesktopPasskeyOrigin('http://instance.localhost:57123/path')).toBe('http://instance.localhost:57123');
    expect(resolveDesktopPasskeyOrigin('http://192.168.1.20:57123')).toBeNull();
    expect(resolveDesktopPasskeyOrigin('http://example.com')).toBeNull();
  });
});

describe('fetchDesktopPasskeyStatus', () => {
  test('checks local status through localhost with sanitized runtime headers', async () => {
    let requestedUrl = '';
    let requestedHeaders = {};
    const status = await fetchDesktopPasskeyStatus({
      url: 'http://127.0.0.1:57123',
      localRuntime: true,
      requestHeaders: {
        Authorization: 'Bearer secret',
        'CF-Access-Client-Id': 'client-id',
      },
      fetchImpl: async (url, init) => {
        requestedUrl = String(url);
        requestedHeaders = init.headers;
        return new Response(JSON.stringify({ enabled: true, hasPasskeys: true, passkeyCount: 2, rpID: 'localhost' }));
      },
    });

    expect(requestedUrl).toBe('http://localhost:57123/auth/passkey/status');
    expect(requestedHeaders).toEqual({ Accept: 'application/json', 'CF-Access-Client-Id': 'client-id' });
    expect(status).toEqual({ enabled: true, hasPasskeys: true, passkeyCount: 2, rpID: 'localhost' });
  });
});

describe('authenticateWithDesktopPasskey', () => {
  test.each(['options', 'verify'])('passes cancellation to %s fetch and rejects late success', async (phase) => {
    const controller = new AbortController();
    const signals = [];
    const temporarySession = {
      webRequest: { onBeforeSendHeaders: () => {} },
      clearStorageData: async () => {},
      clearCache: async () => {},
      clearAuthCache: async () => {},
    };
    class ScriptWindow extends EventEmitter {
      destroyed = false;
      webContents = Object.assign(new EventEmitter(), {
        setWindowOpenHandler: () => {},
        executeJavaScript: async (script) => {
          if (!script.includes('navigator.credentials.get')) return true;
          return runInNewContext(script, {
            window: { __openchamberPasskeyAbort: controller },
            requestAnimationFrame: (callback) => callback(),
            PublicKeyCredential: { parseRequestOptionsFromJSON: (options) => options },
            navigator: { credentials: { get: async () => ({ toJSON: () => ({}) }) } },
            fetch: async (url, init) => {
              signals.push(init.signal);
              if (url.endsWith('/options')) {
                return { ok: true, json: async () => {
                  if (phase === 'options') controller.abort();
                  return { requestId: 'fixture', optionsJSON: {} };
                } };
              }
              return { ok: true, json: async () => {
                controller.abort();
                return { clientToken: 'fixture-only' };
              } };
            },
          });
        },
      });
      removeMenu() {}
      isDestroyed() { return this.destroyed; }
      async loadURL() {}
      show() {}
      focus() {}
      close() { this.destroyed = true; this.emit('closed'); }
    }
    const result = await authenticateWithDesktopPasskey({
      BrowserWindow: ScriptWindow,
      session: { fromPartition: () => temporarySession },
      platform: 'win32',
      url: 'https://remote.example',
    });
    expect(result).toEqual({ supported: true, ok: false, cancelled: true });
    expect(signals).toEqual(phase === 'options' ? [controller.signal] : [controller.signal, controller.signal]);
  });

  test.each(['cancel', 'close', 'parent', 'timeout', 'loading', 'setup'])('settles %s even when renderer work never settles', async (action) => {
    const windows = [];
    let storageCleared = 0;
    const temporarySession = {
      webRequest: { onBeforeSendHeaders: () => undefined },
      clearStorageData: async () => { storageCleared += 1; },
      clearCache: async () => undefined,
      clearAuthCache: async () => undefined,
    };
    const session = { fromPartition: () => temporarySession };
    class FakeBrowserWindow extends EventEmitter {
      destroyed = false;
      shown = false;
      webContents = Object.assign(new EventEmitter(), {
        setWindowOpenHandler: () => undefined,
        executeJavaScript: (script) => {
          if (action === 'setup') return new Promise(() => {});
          if (script.includes('navigator.credentials.get')) {
            return new Promise(() => {});
          }
          return Promise.resolve(true);
        },
      });

      constructor() {
        super();
        windows.push(this);
      }

      removeMenu() {}
      isDestroyed() { return this.destroyed; }
      loadURL() { return action === 'loading' ? new Promise(() => {}) : Promise.resolve(); }
      show() { this.shown = true; }
      focus() {}
      close() {
        if (this.destroyed) return;
        this.destroyed = true;
        this.emit('closed');
      }
    }

    const parent = Object.assign(new EventEmitter(), { isDestroyed: () => false });
    const authentication = authenticateWithDesktopPasskey({
      BrowserWindow: FakeBrowserWindow,
      session,
      parent,
      platform: 'win32',
      url: 'https://remote.example',
      ui: { title: 'Use passkey', cancelLabel: 'Cancel passkey' },
      timeoutMs: action === 'timeout' ? 10 : 1_000,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(windows).toHaveLength(1);
    expect(windows[0].shown).toBe(action !== 'loading' && action !== 'setup');
    if (action === 'parent') parent.emit('closed');
    else if (action === 'close') windows[0].close();
    else if (action !== 'timeout') expect(cancelDesktopPasskeyAuthentication()).toBe(true);
    expect(await authentication).toEqual({ supported: true, ok: false, cancelled: true });
    expect(storageCleared).toBe(1);
    expect(cancelDesktopPasskeyAuthentication()).toBe(false);
    expect(parent.listenerCount('closed')).toBe(0);
  });
});
