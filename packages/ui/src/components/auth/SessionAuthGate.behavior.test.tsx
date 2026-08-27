import { afterEach, describe, expect, mock, test } from 'bun:test';

type ComponentFn<P extends Record<string, unknown> = Record<string, unknown>> = (props: P) => unknown;

type HookRecord = {
  values: unknown[];
  deps: Array<unknown[] | undefined>;
};

type HookEffect = () => void | (() => void);
type HookCallback = (...args: unknown[]) => unknown;
type JSXProps = Record<string, unknown> & { children?: unknown };
type JSXElementType<P extends Record<string, unknown> = Record<string, unknown>> = ComponentFn<P> | string | symbol;

type DesktopMockInvokeArgs = {
  url?: string;
  password?: string;
  trustDevice?: boolean;
  requestHeaders?: Record<string, string>;
  title?: string;
  cancelLabel?: string;
  theme?: {
    '--surface-background'?: string;
    '--surface-foreground'?: string;
    '--surface-muted-foreground'?: string;
    '--surface-elevated'?: string;
    '--interactive-border'?: string;
    '--interactive-hover'?: string;
    '--interactive-focus-ring'?: string;
    '--primary-base'?: string;
  };
};

const hookRecords = new Map<unknown, HookRecord>();
let currentRecord: HookRecord | null = null;
let hookIndex = 0;
let pendingEffects: Array<() => void> = [];
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

afterEach(() => {
  if (originalWindow) {
    Object.defineProperty(globalThis, 'window', originalWindow);
  } else {
    Reflect.deleteProperty(globalThis, 'window');
  }
});

const resetHarness = () => {
  hookRecords.clear();
  currentRecord = null;
  hookIndex = 0;
  pendingEffects = [];
  runtimeApiBaseUrl = '';
  runtimeKey = 'local';
  runtimeEndpointChangedListener = null;
  desktopPasskeySupported = false;
  desktopInvoke = async () => null;
  desktopHostsGetCalls = 0;
  desktopHostsSetCalls = 0;
  runtimeSwitchCalls = 0;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      isSecureContext: false,
      localStorage: {
        getItem: () => null,
        setItem: () => undefined,
      },
      document: { documentElement: {} },
      getComputedStyle: () => ({ getPropertyValue: () => '' }),
      setTimeout: (callback: () => void) => {
        queueMicrotask(callback);
        return 0;
      },
      clearTimeout: () => undefined,
    },
  });
};

const shallowEqualDeps = (left?: unknown[], right?: unknown[]): boolean => {
  if (!left || !right) return false;
  if (left.length !== right.length) return false;
  return left.every((value, index) => Object.is(value, right[index]));
};

const getRecord = (component: unknown): HookRecord => {
  const existing = hookRecords.get(component);
  if (existing) return existing;
  const record: HookRecord = { values: [], deps: [] };
  hookRecords.set(component, record);
  return record;
};

const getHookRecord = (): HookRecord => {
  if (!currentRecord) {
    throw new Error('Hooks can only run during a render pass');
  }
  return currentRecord;
};

const renderComponent = <P extends Record<string, unknown>>(component: ComponentFn<P>, props: P): unknown => {
  const previousRecord = currentRecord;
  const previousHookIndex = hookIndex;
  currentRecord = getRecord(component);
  hookIndex = 0;

  try {
    return component(props);
  } finally {
    currentRecord = previousRecord;
    hookIndex = previousHookIndex;
  }
};

function useCallback<T extends HookCallback>(callback: T, deps?: unknown[]): T {
  const record = getHookRecord();
  const index = hookIndex++;
  const previousDeps = record.deps[index];
  if (!shallowEqualDeps(previousDeps, deps)) {
    record.values[index] = callback;
    record.deps[index] = deps;
  }
  return record.values[index] as T;
}

function useEffect(effect: HookEffect, deps?: unknown[]): void {
  const record = getHookRecord();
  const index = hookIndex++;
  const previousDeps = record.deps[index];
  if (!shallowEqualDeps(previousDeps, deps)) {
    record.deps[index] = deps;
    pendingEffects.push(() => {
      effect();
    });
  }
}

function useMemo<T>(factory: () => T, deps?: unknown[]): T {
  const record = getHookRecord();
  const index = hookIndex++;
  const previousDeps = record.deps[index];
  if (!shallowEqualDeps(previousDeps, deps)) {
    record.values[index] = factory();
    record.deps[index] = deps;
  }
  return record.values[index] as T;
}

function useRef<T>(initialValue: T): { current: T } {
  const record = getHookRecord();
  const index = hookIndex++;
  if (record.values[index] === undefined) {
    record.values[index] = { current: initialValue };
  }
  return record.values[index] as { current: T };
}

function useState<T>(initialValue: T | (() => T)): readonly [T, (next: T | ((prev: T) => T)) => void] {
  const record = getHookRecord();
  const index = hookIndex++;
  if (record.values[index] === undefined) {
    record.values[index] = typeof initialValue === 'function'
      ? (initialValue as () => T)()
      : initialValue;
  }

  const setState = (next: T | ((prev: T) => T)) => {
    record.values[index] = typeof next === 'function'
      ? (next as (prev: T) => T)(record.values[index] as T)
      : next;
  };

  return [record.values[index] as T, setState] as const;
}

function jsx<P extends Record<string, unknown>>(type: JSXElementType<P>, props: JSXProps & P): unknown {
  if (type === reactJsxRuntime.Fragment) {
    return props.children ?? null;
  }

  if (typeof type === 'function') {
    return renderComponent(type, props as P);
  }

  return { type, props };
}

const ReactMock = {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
};

const reactJsxRuntime = {
  Fragment: Symbol('Fragment'),
  jsx,
  jsxs: jsx,
  jsxDEV: jsx,
};

let desktopShell = false;
let runtimeFetchRejects = true;
let runtimeApiBaseUrl = '';
let runtimeKey = 'local';
let runtimeEndpointChangedListener: (() => void) | null = null;
let desktopPasskeySupported = false;
let desktopInvoke: (command?: string, args?: DesktopMockInvokeArgs) => Promise<unknown> = async () => null;
let desktopHostsGetCalls = 0;
let desktopHostsSetCalls = 0;
let runtimeSwitchCalls = 0;

mock.module('react/jsx-runtime', () => reactJsxRuntime);
mock.module('react/jsx-dev-runtime', () => reactJsxRuntime);

mock.module('react', () => ({
  __esModule: true,
  default: ReactMock,
  ...ReactMock,
}));

mock.module('@simplewebauthn/browser', () => ({
  browserSupportsWebAuthn: mock(() => false),
}));

mock.module('@/components/ui/button', () => ({
  Button: (props: JSXProps) => ({ type: 'button', props }),
}));

mock.module('@/components/ui/checkbox', () => ({
  Checkbox: () => null,
}));

mock.module('@/components/ui/input', () => ({
  Input: (props: JSXProps) => ({ type: 'input', props }),
}));

mock.module('@/components/ui', () => ({
  toast: {
    success: mock(() => undefined),
    error: mock(() => undefined),
    message: mock(() => undefined),
  },
}));

mock.module('@/components/ui/OpenChamberLogo', () => ({
  OpenChamberLogo: () => 'logo',
}));

mock.module('@/components/icon/Icon', () => ({
  Icon: () => null,
}));

mock.module('@/components/desktop/DesktopHostSwitcher', () => ({
  DesktopHostSwitcherInline: () => 'host-switcher',
}));

mock.module('@/lib/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

mock.module('@/lib/desktop', () => ({
  cancelDesktopPasskeyAuthentication: () => {
    if (desktopPasskeySupported) void desktopInvoke('desktop_cancel_passkey_authentication');
  },
  getDesktopPasskeyStatus: (url: string, requestHeaders: Record<string, string>) => desktopInvoke('desktop_passkey_status', { url, requestHeaders }),
  invokeDesktop: (command: string, args?: DesktopMockInvokeArgs) => desktopInvoke(command, args),
  isDesktopShell: mock(() => desktopShell),
  isVSCodeRuntime: mock(() => false),
  requestDesktopPasskeyAuthentication: (args: DesktopMockInvokeArgs) => desktopInvoke('desktop_authenticate_with_passkey', args),
  supportsDesktopPasskeyAuthentication: () => desktopPasskeySupported,
}));

mock.module('@/lib/persistence', () => ({
  initializeAppearancePreferences: mock(() => Promise.resolve()),
  syncDesktopSettings: mock(() => Promise.resolve()),
}));

mock.module('@/lib/directoryPersistence', () => ({
  applyPersistedDirectoryPreferences: mock(() => Promise.resolve()),
}));

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: mock(async () => {
    if (runtimeFetchRejects) {
      throw new Error('offline');
    }

    return new Response(JSON.stringify({ authenticated: false }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }),
}));

mock.module('@/lib/runtime-auth', () => ({
  getRuntimeExtraHeadersSync: mock(() => ({})),
}));

const authSessionStoreState = {
  state: 'ok',
  markAuthenticated: () => undefined,
};
const useAuthSessionStoreMock = Object.assign(
  (selector: (state: typeof authSessionStoreState) => unknown) => selector(authSessionStoreState),
  { getState: () => authSessionStoreState },
);

mock.module('@/lib/runtime-auth-expiry', () => ({
  installAuthSessionFocusWatch: mock(() => undefined),
  useAuthSessionStore: useAuthSessionStoreMock,
}));

mock.module('@/lib/runtime-switch', () => ({
  getRuntimeApiBaseUrl: () => runtimeApiBaseUrl,
  getRuntimeKey: () => runtimeKey,
  subscribeRuntimeEndpointChanged: (listener: () => void) => {
    runtimeEndpointChangedListener = listener;
    return () => {
      if (runtimeEndpointChangedListener === listener) runtimeEndpointChangedListener = null;
    };
  },
  switchRuntimeEndpoint: () => { runtimeSwitchCalls += 1; },
}));

mock.module('@/lib/desktopHosts', () => ({
  desktopHostsGet: () => {
    desktopHostsGetCalls += 1;
    return Promise.resolve(null);
  },
  desktopHostsSet: () => {
    desktopHostsSetCalls += 1;
    return Promise.resolve();
  },
  getDesktopHostApiUrl: mock(() => ''),
  normalizeHostUrl: mock(() => ''),
}));

mock.module('@/lib/passkeys', () => ({
  authenticateWithPasskey: mock(() => Promise.resolve(null)),
  cancelPasskeyCeremony: mock(() => undefined),
  defaultPasskeyStatus: { enabled: false, hasPasskeys: false, passkeyCount: 0, rpID: null },
  fetchPasskeyStatus: mock(() => Promise.resolve({ enabled: false, hasPasskeys: false, passkeyCount: 0, rpID: null })),
  isPasskeyCeremonyAbort: mock(() => false),
  registerCurrentDevicePasskey: mock(() => Promise.resolve(null)),
}));

const { SessionAuthGate } = await import('./SessionAuthGate');

const flushEffects = async () => {
  while (pendingEffects.length > 0) {
    const effects = pendingEffects;
    pendingEffects = [];
    for (const effect of effects) {
      effect();
    }
    await Promise.resolve();
  }
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
};

const renderGate = async () => {
  const firstPass = renderComponent(SessionAuthGate, { children: 'child' });
  await flushEffects();
  const secondPass = renderComponent(SessionAuthGate, { children: 'child' });
  await flushEffects();
  return secondPass ?? firstPass;
};

const collectText = (node: unknown): string => {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map((child) => collectText(child)).join(' ');
  if (typeof node === 'object') {
    const element = node as { props?: { children?: unknown } };
    return collectText(element.props?.children);
  }
  return '';
};

const findElement = (node: unknown, type: string): { type: string; props: JSXProps } | null => {
  if (!node || typeof node !== 'object') return null;
  const element = node as { type?: unknown; props?: JSXProps };
  if (element.type === type && element.props) return { type, props: element.props };
  const children = element.props?.children;
  if (Array.isArray(children)) {
    for (const child of children) {
      const match = findElement(child, type);
      if (match) return match;
    }
    return null;
  }
  return findElement(children, type);
};

const findElementByText = (node: unknown, type: string, text: string): { type: string; props: JSXProps } | null => {
  if (!node || typeof node !== 'object') return null;
  const element = node as { type?: unknown; props?: JSXProps };
  if (element.type === type && element.props && collectText(element).includes(text)) {
    return { type, props: element.props };
  }
  const children = element.props?.children;
  if (Array.isArray(children)) {
    for (const child of children) {
      const match = findElementByText(child, type, text);
      if (match) return match;
    }
    return null;
  }
  return findElementByText(children, type, text);
};

describe('SessionAuthGate status-check failure behavior', () => {
  test('keeps non-desktop status-check rejection on the error screen', async () => {
    resetHarness();
    desktopShell = false;
    runtimeFetchRejects = true;

    const tree = await renderGate();
    const text = collectText(tree);

    expect(text).toContain('sessionAuth.error.networkTitle');
    expect(text).not.toContain('sessionAuth.locked.unlockTitle');
  });

  test('keeps desktop-shell status-check rejection on the locked password prompt', async () => {
    resetHarness();
    desktopShell = true;
    runtimeFetchRejects = true;

    const tree = await renderGate();
    const text = collectText(tree);

    expect(text).toContain('sessionAuth.locked.unlockTitle');
    expect(text).not.toContain('sessionAuth.error.networkTitle');
  });

  test('discards a password completion after switching to another host', async () => {
    resetHarness();
    desktopShell = true;
    runtimeFetchRejects = false;
    runtimeApiBaseUrl = 'https://host-a.example';
    runtimeKey = 'host:a';
    let resolveLogin: (value: unknown) => void = () => {
      throw new Error('Password login did not start');
    };
    desktopInvoke = () => new Promise((resolve) => { resolveLogin = resolve; });

    const lockedTree = await renderGate();
    const input = findElement(lockedTree, 'input');
    expect(input).not.toBeNull();
    (input?.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: 'password-a' } });

    const passwordTree = await renderGate();
    const form = findElement(passwordTree, 'form');
    expect(form).not.toBeNull();
    const pending = (form?.props.onSubmit as (event: { preventDefault: () => void }) => Promise<void>)({ preventDefault: () => undefined });
    await Promise.resolve();

    runtimeApiBaseUrl = 'https://host-b.example';
    runtimeKey = 'host:b';
    runtimeEndpointChangedListener?.();
    resolveLogin({ token: 'token-a' });
    await pending;

    expect(desktopHostsGetCalls).toBe(0);
    expect(desktopHostsSetCalls).toBe(0);
    expect(runtimeSwitchCalls).toBe(0);
  });

  test('discards a desktop passkey completion after switching to another host', async () => {
    resetHarness();
    desktopShell = true;
    desktopPasskeySupported = true;
    runtimeFetchRejects = false;
    runtimeApiBaseUrl = 'https://host-a.example';
    runtimeKey = 'host:a';
    type DesktopAuthenticationResult = { supported: boolean; ok: boolean; token: string };
    let resolveAuthentication: (value: DesktopAuthenticationResult) => void = () => {
      throw new Error('Passkey authentication did not start');
    };
    desktopInvoke = (command) => {
      if (command === 'desktop_passkey_status') {
        return Promise.resolve({ enabled: true, hasPasskeys: true, passkeyCount: 1, rpID: 'host-a.example' });
      }
      if (command === 'desktop_authenticate_with_passkey') {
        return new Promise((resolve) => { resolveAuthentication = resolve; });
      }
      return Promise.resolve(null);
    };

    const lockedTree = await renderGate();
    const passkeyButton = findElementByText(lockedTree, 'button', 'sessionAuth.actions.usePasskey');
    expect(passkeyButton).not.toBeNull();
    if (!passkeyButton) throw new Error('Passkey button was not rendered');
    // SAFETY: The test harness records the click handler supplied by SessionAuthGate on this button.
    const pending = (passkeyButton.props.onClick as () => Promise<void>)();
    await Promise.resolve();

    runtimeApiBaseUrl = 'https://host-b.example';
    runtimeKey = 'host:b';
    runtimeEndpointChangedListener?.();
    resolveAuthentication({ supported: true, ok: true, token: 'token-a' });
    await pending;

    expect(desktopHostsGetCalls).toBe(0);
    expect(desktopHostsSetCalls).toBe(0);
    expect(runtimeSwitchCalls).toBe(0);
  });
});
