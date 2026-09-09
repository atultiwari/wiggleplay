/**
 * The `window.wigglePlayHost` bridge injected into the WebView before the games load.
 * Calls travel as JSON messages to the app; replies and status pushes come back via injectJavaScript.
 */
export type HostKind = 'android' | 'ios'

export interface HostCall {
  readonly id: number
  readonly method: 'status' | 'check' | 'download' | 'apply' | 'open'
  readonly url?: string
}

const METHODS: ReadonlySet<string> = new Set(['status', 'check', 'download', 'apply', 'open'])

/** Validates a message sent from the WebView. */
export const parseHostCall = (raw: string): HostCall | null => {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const { id, method, url } = parsed as Partial<HostCall>
    if (typeof id !== 'number' || typeof method !== 'string' || !METHODS.has(method)) return null
    return { id, method: method as HostCall['method'], url: typeof url === 'string' ? url : undefined }
  } catch {
    return null
  }
}

export const bridgeScript = (kind: HostKind, appVersion: string): string => `(function () {
  if (window.wigglePlayHost) return;
  var pending = {}; var seq = 0; var listeners = [];
  function post(message) { window.ReactNativeWebView.postMessage(JSON.stringify(message)); }
  function call(method) {
    return new Promise(function (resolve, reject) {
      var id = ++seq; pending[id] = { resolve: resolve, reject: reject }; post({ id: id, method: method });
    });
  }
  window.__wiggleHostReply = function (id, result, error) {
    var p = pending[id]; if (!p) return; delete pending[id];
    if (error) { p.reject(new Error(error)); } else { p.resolve(result); }
  };
  window.__wiggleHostStatus = function (status) {
    listeners.forEach(function (l) { try { l(status); } catch (e) {} });
  };
  window.wigglePlayHost = {
    kind: ${JSON.stringify(kind)},
    appVersion: ${JSON.stringify(appVersion)},
    getStatus: function () { return call('status'); },
    checkForUpdates: function () { return call('check'); },
    downloadUpdate: function () { return call('download'); },
    applyUpdate: function () { return call('apply'); },
    onStatus: function (l) { listeners.push(l); return function () { listeners = listeners.filter(function (x) { return x !== l; }); }; },
    openExternal: function (url) { post({ id: 0, method: 'open', url: String(url) }); }
  };
})(); true;`

export const replyScript = (id: number, result: unknown, error?: string): string => `window.__wiggleHostReply(${id}, ${JSON.stringify(result ?? null)}, ${JSON.stringify(error ?? null)}); true;`
export const statusScript = (status: unknown): string => `window.__wiggleHostStatus(${JSON.stringify(status)}); true;`
