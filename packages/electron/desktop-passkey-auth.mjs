import { sanitizeRuntimeRequestHeaders } from './runtime-request-headers.mjs';

const PASSKEY_STATUS_PATH = '/auth/passkey/status';
const PASSKEY_OPTIONS_PATH = '/auth/passkey/authenticate/options';
const PASSKEY_VERIFY_PATH = '/auth/passkey/authenticate/verify';
const PASSKEY_TIMEOUT_MS = 5 * 60 * 1000;
const PASSKEY_WINDOW_CSS = `
  * { box-sizing: border-box; }
  html, body { width: 100%; height: 100%; margin: 0; }
  body {
    display: grid;
    place-items: center;
    background: var(--surface-background, Canvas);
    color: var(--surface-foreground, CanvasText);
    font-family: Inter, "Segoe UI", system-ui, sans-serif;
  }
  main { width: min(100% - 48px, 340px); text-align: center; }
  .product { margin: 0 0 22px; color: var(--surface-muted-foreground, GrayText); font-size: 12px; font-weight: 650; letter-spacing: .12em; text-transform: uppercase; }
  h1 { margin: 0; font-size: 22px; line-height: 1.25; font-weight: 650; }
  .host { margin: 9px 0 24px; color: var(--surface-muted-foreground, GrayText); font: 12px/1.4 ui-monospace, "Cascadia Mono", monospace; overflow-wrap: anywhere; }
  .spinner { width: 24px; height: 24px; margin: 0 auto 24px; border: 2px solid var(--interactive-border, GrayText); border-top-color: var(--primary-base, CanvasText); border-radius: 999px; animation: spin .85s linear infinite; }
  button {
    min-width: 108px;
    min-height: 36px;
    padding: 0 16px;
    border: 1px solid var(--interactive-border, GrayText);
    border-radius: 8px;
    background: var(--surface-elevated, ButtonFace);
    color: var(--surface-foreground, ButtonText);
    font: inherit;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }
  button:hover { background: var(--interactive-hover, ButtonFace); }
  button:focus-visible { outline: 2px solid var(--interactive-focus-ring, Highlight); outline-offset: 2px; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spinner { animation-duration: 1.8s; } }
`;

let activeAuthentication = null;

const isLocalhostName = (hostname) => hostname === 'localhost' || hostname.endsWith('.localhost');
const isStringValue = (value) => Object.prototype.toString.call(value) === '[object String]';
const isPlainObject = (value) => Object.prototype.toString.call(value) === '[object Object]';

export const resolveDesktopPasskeyOrigin = (rawUrl, { localRuntime = false } = {}) => {
  try {
    const url = new URL(String(rawUrl || '').trim());
    if (url.protocol === 'http:' && localRuntime) {
      url.hostname = 'localhost';
    }
    if (url.protocol === 'http:' && !isLocalhostName(url.hostname)) return null;
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
};

const parsePasskeyStatus = (payload) => ({
  enabled: payload?.enabled === true,
  hasPasskeys: payload?.hasPasskeys === true,
  passkeyCount: Number.isFinite(payload?.passkeyCount) ? payload.passkeyCount : 0,
  rpID: isStringValue(payload?.rpID) && payload.rpID ? payload.rpID : null,
});

export const fetchDesktopPasskeyStatus = async ({
  url,
  localRuntime = false,
  requestHeaders = {},
  fetchImpl = fetch,
} = {}) => {
  const origin = resolveDesktopPasskeyOrigin(url, { localRuntime });
  if (!origin) return null;
  const response = await fetchImpl(new URL(PASSKEY_STATUS_PATH, `${origin}/`), {
    method: 'GET',
    signal: AbortSignal.timeout(10_000),
    headers: {
      ...sanitizeRuntimeRequestHeaders(requestHeaders),
      Accept: 'application/json',
    },
  });
  if (!response.ok) return null;
  return parsePasskeyStatus(await response.json().catch(() => null));
};

const buildWindowSetupScript = ({ title, cancelLabel, hostname, theme }) => `(() => {
  const config = ${JSON.stringify({ title, cancelLabel, hostname, theme })};
  document.open();
  document.write('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title></title></head><body></body></html>');
  document.close();
  document.title = 'OpenChamber';
  const root = document.documentElement;
  for (const [name, value] of Object.entries(config.theme || {})) {
    if (typeof value === 'string' && value.trim()) root.style.setProperty(name, value.trim());
  }
  const style = document.createElement('style');
  style.textContent = ${JSON.stringify(PASSKEY_WINDOW_CSS)};
  document.head.append(style);
  const main = document.createElement('main');
  const product = document.createElement('p');
  product.className = 'product';
  product.textContent = 'OpenChamber';
  const heading = document.createElement('h1');
  heading.textContent = config.title;
  const host = document.createElement('p');
  host.className = 'host';
  host.textContent = config.hostname;
  const spinner = document.createElement('div');
  spinner.className = 'spinner';
  spinner.setAttribute('aria-hidden', 'true');
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = config.cancelLabel;
  window.__openchamberPasskeyAbort = new AbortController();
  cancel.addEventListener('click', () => window.__openchamberPasskeyAbort.abort());
  main.append(product, heading, host, spinner, cancel);
  document.body.append(main);
  return true;
})()`;

const buildCeremonyScript = (verificationPayload) => `(async () => {
  const decodeBase64Url = (value) => {
    const base64 = String(value).replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(String(value).length / 4) * 4, '=');
    const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
    return bytes.buffer;
  };
  const encodeBase64Url = (value) => {
    const bytes = new Uint8Array(value);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).split('+').join('-').split('/').join('_').replace(/=+$/g, '');
  };
  const responseJson = (credential) => {
    if (typeof credential.toJSON === 'function') return credential.toJSON();
    return {
      id: credential.id,
      rawId: encodeBase64Url(credential.rawId),
      response: {
        authenticatorData: encodeBase64Url(credential.response.authenticatorData),
        clientDataJSON: encodeBase64Url(credential.response.clientDataJSON),
        signature: encodeBase64Url(credential.response.signature),
        userHandle: credential.response.userHandle ? encodeBase64Url(credential.response.userHandle) : undefined,
      },
      type: credential.type,
      clientExtensionResults: credential.getClientExtensionResults(),
      authenticatorAttachment: credential.authenticatorAttachment,
    };
  };
  const readError = async (response, fallback) => {
    const payload = await response.json().catch(() => null);
    return typeof payload?.error === 'string' && payload.error.trim() ? payload.error.trim() : fallback;
  };
  try {
    await new Promise(resolve => requestAnimationFrame(() => resolve()));
    const optionsResponse = await fetch(${JSON.stringify(PASSKEY_OPTIONS_PATH)}, {
      method: 'POST',
      credentials: 'include',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    });
    if (!optionsResponse.ok) throw new Error(await readError(optionsResponse, 'Passkey sign-in is not available right now.'));
    const { requestId, optionsJSON } = await optionsResponse.json();
    const publicKey = typeof PublicKeyCredential.parseRequestOptionsFromJSON === 'function'
      ? PublicKeyCredential.parseRequestOptionsFromJSON(optionsJSON)
      : {
          ...optionsJSON,
          challenge: decodeBase64Url(optionsJSON.challenge),
          allowCredentials: Array.isArray(optionsJSON.allowCredentials)
            ? optionsJSON.allowCredentials.map(item => ({ ...item, id: decodeBase64Url(item.id) }))
            : undefined,
        };
    const credential = await navigator.credentials.get({
      publicKey,
      signal: window.__openchamberPasskeyAbort.signal,
    });
    if (!credential) throw new Error('Passkey sign-in was canceled.');
    const verifyResponse = await fetch(${JSON.stringify(PASSKEY_VERIFY_PATH)}, {
      method: 'POST',
      credentials: 'include',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId,
        response: responseJson(credential),
        ...${JSON.stringify(verificationPayload)},
      }),
    });
    if (!verifyResponse.ok) throw new Error(await readError(verifyResponse, 'Passkey sign-in failed.'));
    const payload = await verifyResponse.json().catch(() => null);
    return { ok: true, token: typeof payload?.clientToken === 'string' ? payload.clientToken : '' };
  } catch (error) {
    if (window.__openchamberPasskeyAbort.signal.aborted || error?.name === 'AbortError' || error?.name === 'NotAllowedError') {
      return { ok: false, cancelled: true };
    }
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
})()`;

const configureRuntimeHeaders = (targetSession, origin, requestHeaders) => {
  const safeHeaders = sanitizeRuntimeRequestHeaders(requestHeaders);
  targetSession.webRequest.onBeforeSendHeaders({ urls: [`${origin}/*`] }, (details, callback) => {
    callback({ requestHeaders: { ...details.requestHeaders, ...safeHeaders } });
  });
};

const clearTemporarySession = async (targetSession) => {
  await Promise.allSettled([
    targetSession.clearStorageData(),
    targetSession.clearCache(),
    targetSession.clearAuthCache(),
  ]);
};

export const cancelDesktopPasskeyAuthentication = () => {
  if (!activeAuthentication) return false;
  activeAuthentication.cancel();
  return true;
};

export const authenticateWithDesktopPasskey = async ({
  BrowserWindow,
  session,
  parent,
  platform,
  url,
  localRuntime = false,
  trustDevice = false,
  requestHeaders = {},
  clientIdentity = {},
  ui = {},
  timeoutMs = PASSKEY_TIMEOUT_MS,
} = {}) => {
  if (platform !== 'win32') return { supported: false };
  const origin = resolveDesktopPasskeyOrigin(url, { localRuntime });
  if (!origin) return { supported: true, ok: false, error: 'Passkeys require HTTPS or localhost.' };
  if (activeAuthentication) {
    activeAuthentication.focus();
    return { supported: true, ok: false, cancelled: true };
  }

  const targetSession = session.fromPartition(`openchamber-passkey-${globalThis.crypto.randomUUID()}`, { cache: false });
  configureRuntimeHeaders(targetSession, origin, requestHeaders);
  const ownerWindow = parent && !parent.isDestroyed() ? parent : null;
  const authWindow = new BrowserWindow({
    width: 420,
    height: 300,
    minWidth: 420,
    minHeight: 300,
    maxWidth: 420,
    maxHeight: 300,
    show: false,
    parent: ownerWindow || undefined,
    modal: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    title: 'OpenChamber',
    webPreferences: {
      session: targetSession,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  authWindow.removeMenu();
  authWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const statusUrl = new URL(PASSKEY_STATUS_PATH, `${origin}/`).toString();
  authWindow.webContents.on('will-navigate', (event, navigationUrl) => {
    if (navigationUrl !== statusUrl) event.preventDefault();
  });
  authWindow.webContents.on('will-redirect', (event) => event.preventDefault());

  let settle;
  const resultPromise = new Promise((resolve) => { settle = resolve; });
  let settled = false;
  const finish = (result) => {
    if (settled) return;
    settled = true;
    settle(result);
    if (!authWindow.isDestroyed()) authWindow.close();
  };
  const cancel = () => {
    if (!authWindow.isDestroyed()) {
      void authWindow.webContents.executeJavaScript('window.__openchamberPasskeyAbort?.abort()', true).catch(() => undefined);
    }
    finish({ supported: true, ok: false, cancelled: true });
  };
  activeAuthentication = {
    cancel,
    focus: () => {
      if (authWindow.isDestroyed()) return;
      authWindow.show();
      authWindow.focus();
    },
  };

  const parentClosed = () => cancel();
  ownerWindow?.once('closed', parentClosed);
  authWindow.once('closed', () => finish({ supported: true, ok: false, cancelled: true }));
  const timeout = setTimeout(cancel, timeoutMs);

  try {
    await authWindow.loadURL(statusUrl);
    await authWindow.webContents.executeJavaScript(buildWindowSetupScript({
      title: isStringValue(ui.title) ? ui.title : '',
      cancelLabel: isStringValue(ui.cancelLabel) ? ui.cancelLabel : '',
      hostname: new URL(origin).host,
      theme: isPlainObject(ui.theme) ? ui.theme : {},
    }));
    if (!authWindow.isDestroyed()) {
      authWindow.show();
      authWindow.focus();
      const result = await authWindow.webContents.executeJavaScript(buildCeremonyScript({
        trustDevice: trustDevice === true,
        issueClientToken: true,
        clientLabel: 'OpenChamber Desktop',
        ...clientIdentity,
      }), true);
      finish(result?.ok && result.token
        ? { supported: true, ok: true, token: result.token }
        : { supported: true, ok: false, ...(result?.cancelled ? { cancelled: true } : { error: result?.error || 'Passkey sign-in failed.' }) });
    }
  } catch (error) {
    finish({ supported: true, ok: false, error: error instanceof Error ? error.message : String(error) });
  } finally {
    clearTimeout(timeout);
    ownerWindow?.removeListener('closed', parentClosed);
  }

  const result = await resultPromise;
  if (activeAuthentication?.cancel === cancel) activeAuthentication = null;
  await clearTemporarySession(targetSession);
  return result;
};
