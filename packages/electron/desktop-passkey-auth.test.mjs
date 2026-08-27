import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
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
  test('cancels the active ceremony and clears its temporary session', async () => {
    const windows = [];
    let ceremonyReject = () => undefined;
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
          if (script.includes('navigator.credentials.get')) {
            return new Promise((_resolve, reject) => { ceremonyReject = reject; });
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
      loadURL() { return Promise.resolve(); }
      show() { this.shown = true; }
      focus() {}
      close() {
        if (this.destroyed) return;
        this.destroyed = true;
        ceremonyReject(new Error('window closed'));
        this.emit('closed');
      }
    }

    const authentication = authenticateWithDesktopPasskey({
      BrowserWindow: FakeBrowserWindow,
      session,
      platform: 'win32',
      url: 'https://remote.example',
      ui: { title: 'Use passkey', cancelLabel: 'Cancel passkey' },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(windows).toHaveLength(1);
    expect(windows[0].shown).toBe(true);
    expect(cancelDesktopPasskeyAuthentication()).toBe(true);
    expect(await authentication).toEqual({ supported: true, ok: false, cancelled: true });
    expect(storageCleared).toBe(1);
    expect(cancelDesktopPasskeyAuthentication()).toBe(false);
  });
});
