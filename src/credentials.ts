export type Keychain = {
  keychainWrite(service: string, name: string, password: string): boolean;
  keychainRead(service: string, name: string): string | false;
};

export function canonicalEndpoint(value: string): { base: string; requestUrl: string } {
  const match = value.trim().match(/^(https?):\/\/([^/?#]+)(\/[A-Za-z0-9._~/-]*)?\/?$/i);
  if (!match || match[2].includes('@')) throw new Error('Enter an HTTPS API base URL without credentials or a query');
  const scheme = match[1].toLowerCase();
  const authority = match[2];
  const hostPort = authority.match(/^(\[[0-9a-f:]+\]|[a-z0-9.-]+)(?::(\d{1,5}))?$/i);
  if (!hostPort) throw new Error('Invalid API host');
  const host = hostPort[1].toLowerCase();
  const port = hostPort[2] ? Number(hostPort[2]) : null;
  if (port !== null && (port < 1 || port > 65535)) throw new Error('Invalid API port');
  if (scheme === 'http' && !['localhost', '127.0.0.1', '[::1]'].includes(host)) throw new Error('HTTP is allowed only for loopback testing');
  if (host !== '[::1]' && host !== 'localhost' && host !== '127.0.0.1' &&
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host)) {
    throw new Error('Invalid API host');
  }
  const path = (match[3] ?? '').replace(/\/+$/, '');
  if (path.split('/').some(segment => segment === '.' || segment === '..')) throw new Error('Invalid API path');
  const normalizedPort = port && !((scheme === 'https' && port === 443) || (scheme === 'http' && port === 80)) ? `:${port}` : '';
  const base = `${scheme}://${host}${normalizedPort}${path}`;
  return { base, requestUrl: `${base}/chat/completions` };
}

export class Credentials {
  constructor(private readonly keychain: Keychain) {
    if (typeof keychain.keychainRead !== 'function' || typeof keychain.keychainWrite !== 'function') {
      throw new Error('IINA Keychain API is unavailable');
    }
  }

  private service(endpoint: string): string { return `api:${canonicalEndpoint(endpoint).base}`; }

  hasSavedKey(endpoint: string): boolean {
    return typeof this.keychain.keychainRead(this.service(endpoint), 'api-key') === 'string';
  }

  save(endpoint: string, key: string): void {
    if (!key || key.length > 512 || /[\r\n]/.test(key)) throw new Error('Invalid API key');
    if (this.keychain.keychainWrite(this.service(endpoint), 'api-key', key) !== true) {
      throw new Error('IINA Keychain could not save the key');
    }
  }

  // Only privileged request startup calls this. The value never goes to a WebView.
  readForRequest(endpoint: string): string | null {
    const value = this.keychain.keychainRead(this.service(endpoint), 'api-key');
    return typeof value === 'string' ? value : null;
  }
}
