import { test, expect } from 'bun:test';
import { canonicalEndpoint, Credentials } from '../src/credentials';

test('endpoint path, TLS, loopback, and credential boundaries', () => {
  expect(canonicalEndpoint(' HTTPS://Example.COM:443/v1/ ').requestUrl).toBe(
    'https://example.com/v1/chat/completions'
  );
  expect(canonicalEndpoint('http://127.0.0.1:47891').requestUrl).toBe(
    'http://127.0.0.1:47891/chat/completions'
  );

  for (const bad of [
    'http://example.com/v1',
    'https://user:pass@example.com',
    'https://example.com/v1?x=1',
    'https://example.com/../v1'
  ]) {
    expect(() => canonicalEndpoint(bad)).toThrow();
  }
});

test('Keychain replacement and endpoint isolation, no plaintext fallback', () => {
  // 1. Create an endpoint-scoped Keychain double with controllable write failure.
  const entries = new Map<string, string>();
  let fail = false;
  const keychain = {
    keychainWrite: (service: string, name: string, value: string) => {
      if (fail) {
        return false;
      }

      entries.set(`${service}:${name}`, value);

      return true;
    },
    keychainRead: (service: string, name: string) => entries.get(`${service}:${name}`) ?? false
  };

  // 2. Save and replace a key without exposing it to another endpoint.
  const credentials = new Credentials(keychain);
  credentials.save('https://example.com/v1', 'first');

  expect(credentials.hasSavedKey('https://example.com/v1')).toBe(true);
  expect(credentials.hasSavedKey('https://example.com/v2')).toBe(false);

  credentials.save('https://example.com/v1', 'replacement');

  expect(credentials.readForRequest('https://example.com/v1')).toBe('replacement');

  // 3. Keep the saved value when Keychain rejects the replacement.
  fail = true;

  expect(() => credentials.save('https://example.com/v1', 'bad')).toThrow();
  expect(credentials.readForRequest('https://example.com/v1')).toBe('replacement');
});
