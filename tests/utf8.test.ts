import { test, expect } from 'bun:test';
import { utf8Bytes } from '../src/utf8';

test('UTF-8 size works without browser globals and rejects malformed surrogates', () => {
  expect(utf8Bytes('AÖ🙂')).toBe(7);
  expect(() => utf8Bytes('\ud800')).toThrow();
});
