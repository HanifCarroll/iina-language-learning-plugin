import { test, expect } from 'bun:test';
import { FallbackDeadline, isDeepSeekEndpoint, otherProvider } from '../src/fallback';

test('fallback waits five seconds for answer text rather than stream keepalives', () => {
  const deadline = new FallbackDeadline(100);
  deadline.receiveAnswer(' \n');
  expect(deadline.isDue(5_099)).toBe(false);
  expect(deadline.isDue(5_100)).toBe(true);
});

test('the first answer disables fallback even if DeepSeek later stalls', () => {
  const deadline = new FallbackDeadline(100);
  deadline.receiveAnswer('An answer');
  expect(deadline.isDue(100_000)).toBe(false);
});

test('DeepSeek-specific options recognize only the official HTTPS host', () => {
  expect(isDeepSeekEndpoint('https://API.DeepSeek.com:443/v1/')).toBe(true);
  for (const endpoint of [
    'https://api.deepseek.com.attacker.example',
    'https://attacker.example/api.deepseek.com',
    'https://api.deepseek.com:8443',
    'https://api.openai.com/v1',
    'http://127.0.0.1:47891'
  ]) {
    expect(isDeepSeekEndpoint(endpoint)).toBe(false);
  }
});

test('the fallback is always the other provider', () => {
  expect(otherProvider('luna')).toBe('configured');
  expect(otherProvider('configured')).toBe('luna');
});
