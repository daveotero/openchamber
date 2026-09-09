import { afterEach, describe, expect, test } from 'bun:test';

import { getDesktopPasskeyStatus, getDesktopPasskeyTargetUrl, isBrowserClientRuntime, supportsDesktopPasskeyAuthentication } from './desktop';
import { getPasskeySupportState } from './passkeys';
import { adoptRelayTunnel, deactivateRelayTunnel } from './relay/runtime-tunnel';

describe('browser client runtime', () => {
  test('uses browser file behavior only outside the Electron shell', () => {
    expect(isBrowserClientRuntime('web', false)).toBe(true);
    expect(isBrowserClientRuntime('web', true)).toBe(false);
  });

  test('keeps desktop and VS Code runtime behavior out of browser-only flows', () => {
    expect(isBrowserClientRuntime('desktop', false)).toBe(false);
    expect(isBrowserClientRuntime('vscode', false)).toBe(false);
  });
});

describe('desktop passkey capability', () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  afterEach(() => {
    deactivateRelayTunnel();
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  });

  test('trusted packaged authentication does not enable browser registration', () => {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {
      __OPENCHAMBER_ELECTRON__: { runtime: 'electron', passkeyAuthentication: true },
      __OPENCHAMBER_DESKTOP__: { invoke: async () => null },
      __OPENCHAMBER_LOCAL_ORIGIN__: 'http://127.0.0.1:3901',
      location: { protocol: 'openchamber-ui:' },
      isSecureContext: true,
    } });
    expect(supportsDesktopPasskeyAuthentication()).toBe(true);
    expect(getPasskeySupportState().supported).toBe(false);
    expect(getDesktopPasskeyTargetUrl()).toBe('http://127.0.0.1:3901');
  });

  test('HMR with an empty API base uses the injected backend, not the page port', () => {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {
      __OPENCHAMBER_ELECTRON__: { runtime: 'electron', passkeyAuthentication: true },
      __OPENCHAMBER_DESKTOP__: { invoke: async () => null },
      __OPENCHAMBER_LOCAL_ORIGIN__: 'http://127.0.0.1:3901',
      __OPENCHAMBER_API_BASE_URL__: '',
      location: { protocol: 'http:', origin: 'http://127.0.0.1:5173' },
    } });
    expect(getDesktopPasskeyTargetUrl()).toBe('http://127.0.0.1:3901');
  });

  test('remote-rendered HTTPS retains browser support without native IPC capability', () => {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {
      __OPENCHAMBER_ELECTRON__: { runtime: 'electron', passkeyAuthentication: false },
      __OPENCHAMBER_DESKTOP__: { invoke: async () => null },
      location: { protocol: 'https:' },
      isSecureContext: true,
    } });
    expect(supportsDesktopPasskeyAuthentication()).toBe(false);
    expect(getPasskeySupportState().supported).toBe(true);
  });

  test('relay placeholders never reach native status IPC', async () => {
    let calls = 0;
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {
      __OPENCHAMBER_ELECTRON__: { runtime: 'electron', passkeyAuthentication: true },
      __OPENCHAMBER_DESKTOP__: { invoke: async () => { calls += 1; return null; } },
      __OPENCHAMBER_API_BASE_URL__: 'http://127.0.0.1:3901',
    } });
    adoptRelayTunnel({ relayUrl: 'wss://relay.invalid', serverId: 'fixture', hostEncPubJwk: {} }, {
      fetch: async () => { throw new Error('Unexpected relay request'); },
      openWebSocket: () => { throw new Error('Unexpected relay socket'); },
      getStatus: () => ({ state: 'idle' }),
      subscribeStatus: () => () => {},
      close: () => {},
    });
    expect(supportsDesktopPasskeyAuthentication()).toBe(false);
    expect(getDesktopPasskeyTargetUrl()).toBe('');
    expect(await getDesktopPasskeyStatus('http://127.0.0.1:3901', {})).toBeNull();
    expect(calls).toBe(0);
  });
});
