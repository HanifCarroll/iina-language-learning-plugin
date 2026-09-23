import { test, expect } from 'bun:test';
import { Window } from 'happy-dom';
import { mountSidebar } from '../ui/sidebar';

test('sidebar renders untrusted text safely and clears newly typed key after save', async () => {
  const window = new Window();
  (window as unknown as { SyntaxError: typeof SyntaxError }).SyntaxError = SyntaxError;
  window.document.body.innerHTML = (await Bun.file('ui/sidebar.html').text()).split('<body>')[1].split('</body>')[0];
  const handlers = new Map<string, (data: string) => void>();
  const sent: Array<{ name: string; data: any }> = [];
  mountSidebar(window.document as unknown as Document, {
    onMessage: (name, callback) => { handlers.set(name, callback); },
    postMessage: (name, data) => sent.push({ name, data })
  });
  handlers.get('state')!(encodeURIComponent(JSON.stringify({
    status: 'Complete', open: true, overlayEnabled: true, phrase: '<img src=x>', cue: '<script>bad()</script>',
    turns: [{ question: 'Why?', answer: '<img src="https://evil.example/x">', status: 'complete' }],
    settings: { endpoint: 'https://example.com/v1', model: 'test', sourceLanguage: 'Turkish',
      explanationLanguage: 'English', includeSecondary: true, noKeyRequired: false,
      hasSavedKey: false, requestUrl: 'https://example.com/v1/chat/completions' }
  })));
  expect(window.document.querySelectorAll('img,script')).toHaveLength(1); // packaged script element only
  expect(window.document.querySelector('#turns')!.textContent).toContain('<img src="https://evil.example/x">');
  (window.document.querySelector('#settingsToggle') as unknown as HTMLButtonElement).click();
  const key = window.document.querySelector('#apiKey') as unknown as HTMLInputElement;
  key.value = 'new-fixture-value';
  (window.document.querySelector('#saveSettings') as unknown as HTMLButtonElement).click();
  expect(key.value).toBe('');
  expect(sent.at(-1)?.name).toBe('saveSettings');
  expect(sent.at(-1)?.data.key).toBe('new-fixture-value');
  expect(window.document.body.textContent).not.toContain('new-fixture-value');
  window.happyDOM.abort();
});
