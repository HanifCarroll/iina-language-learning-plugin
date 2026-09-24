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
    status: 'Complete', open: true, conversationId: 1, overlayEnabled: true, phrase: '<img src=x>', cue: '<script>bad()</script>',
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

test('sidebar formats a real explanation, keeps source context available, and does not reload stable answers', async () => {
  const window = new Window();
  (window as unknown as { SyntaxError: typeof SyntaxError }).SyntaxError = SyntaxError;
  window.document.body.innerHTML = (await Bun.file('ui/sidebar.html').text()).split('<body>')[1].split('</body>')[0];
  const handlers = new Map<string, (data: string) => void>();
  mountSidebar(window.document as unknown as Document, {
    onMessage: (name, callback) => { handlers.set(name, callback); }, postMessage: () => {}
  });
  const state = (answer: string, status: string, id = 1) => handlers.get('state')!(encodeURIComponent(JSON.stringify({
    status, open: true, conversationId: id, overlayEnabled: true,
    phrase: 'bugüne kadar okulunu bitirir', cue: '...bugüne kadar okulunu bitirir, anladın mı...',
    turns: [{ question: '', answer, status: status === 'Complete' ? 'complete' : 'streaming' }],
    settings: { endpoint: '', model: '', sourceLanguage: 'Turkish', explanationLanguage: 'English',
      includeSecondary: true, noKeyRequired: false, hasSavedKey: false, requestUrl: '' }
  })));
  state('**Natural meaning**  \nBy now...\n\n**Literal meaning**  \nUntil today...\n\n- **bitirir** = finishes', 'Generating…');
  expect(window.document.querySelectorAll('.answer strong')).toHaveLength(3);
  expect(window.document.querySelectorAll('.answer li')).toHaveLength(1);
  expect(window.document.querySelector('#fullCue')?.textContent).toContain('...bugüne kadar');
  expect(window.document.querySelector('details')?.hasAttribute('open')).toBe(false);
  expect(window.document.querySelector('#status')?.hasAttribute('hidden')).toBe(true);
  const answer = window.document.querySelector('.answer');
  (window.document.querySelector('#question') as HTMLTextAreaElement).value = 'A question I am drafting';
  state('**Natural meaning**  \nBy now...\n\n**Literal meaning**  \nUntil today...\n\n- **bitirir** = finishes', 'Complete');
  expect(window.document.querySelector('.answer')).toBe(answer);
  expect((window.document.querySelector('#question') as HTMLTextAreaElement).value).toBe('A question I am drafting');
  expect(window.document.querySelector('.turn-status')?.hasAttribute('hidden')).toBe(true);
  state('A new answer', 'Complete', 2);
  expect(window.document.querySelector('.answer')).not.toBe(answer);
  window.happyDOM.abort();
});

test('model Markdown cannot create HTML, links, or image requests', async () => {
  const window = new Window();
  (window as unknown as { SyntaxError: typeof SyntaxError }).SyntaxError = SyntaxError;
  window.document.body.innerHTML = (await Bun.file('ui/sidebar.html').text()).split('<body>')[1].split('</body>')[0];
  const handlers = new Map<string, (data: string) => void>();
  mountSidebar(window.document as unknown as Document, {
    onMessage: (name, callback) => { handlers.set(name, callback); }, postMessage: () => {}
  });
  handlers.get('state')!(encodeURIComponent(JSON.stringify({
    status: 'Complete', open: true, conversationId: 1, overlayEnabled: true, phrase: 'test', cue: 'test',
    turns: [{ question: '[question](https://evil.example)', status: 'complete',
      answer: '<script>bad()</script>\n\n<img src="https://evil.example/track">\n\n![alt](https://evil.example/image) [click](javascript:bad()) <https://evil.example> **safe**' }],
    settings: { endpoint: '', model: '', sourceLanguage: 'Turkish', explanationLanguage: 'English',
      includeSecondary: true, noKeyRequired: false, hasSavedKey: false, requestUrl: '' }
  })));
  expect(window.document.querySelectorAll('.answer img,.answer script,.answer iframe,.answer a')).toHaveLength(0);
  expect(window.document.querySelector('.answer')?.textContent).toContain('<script>bad()</script>');
  expect(window.document.querySelector('.answer')?.textContent).toContain('alt');
  expect(window.document.querySelector('.answer strong')?.textContent).toBe('safe');
  window.happyDOM.abort();
});
