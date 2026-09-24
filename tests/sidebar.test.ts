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
  (window.document.querySelector('#question') as unknown as HTMLTextAreaElement).value = 'A question I am drafting';
  state('**Natural meaning**  \nBy now...\n\n**Literal meaning**  \nUntil today...\n\n- **bitirir** = finishes', 'Complete');
  expect(window.document.querySelector('.answer')).toBe(answer);
  expect((window.document.querySelector('#question') as unknown as HTMLTextAreaElement).value).toBe('A question I am drafting');
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

test('chat composer grows to three lines and message scrolling follows new replies without stealing reading position', async () => {
  const window = new Window();
  (window as unknown as { SyntaxError: typeof SyntaxError }).SyntaxError = SyntaxError;
  window.document.body.innerHTML = (await Bun.file('ui/sidebar.html').text()).split('<body>')[1].split('</body>')[0];
  const handlers = new Map<string, (data: string) => void>();
  const sent: Array<{ name: string; data: unknown }> = [];
  mountSidebar(window.document as unknown as Document, {
    onMessage: (name, callback) => { handlers.set(name, callback); },
    postMessage: (name, data) => sent.push({ name, data })
  });
  const turns = window.document.querySelector('#turns') as unknown as HTMLElement;
  const question = window.document.querySelector('#question') as unknown as HTMLTextAreaElement;
  let height = 800;
  Object.defineProperty(turns, 'scrollHeight', { get: () => height });
  Object.defineProperty(turns, 'clientHeight', { get: () => 100 });
  Object.defineProperty(question, 'scrollHeight', { get: () => 38 + (question.value.match(/\n/g)?.length ?? 0) * 20 });
  const initial = { question: '', answer: '**Natural meaning**\nHello', status: 'complete' };
  const followUp = { question: '<img src=x> Why?', answer: '', status: 'streaming' };
  const state = (items: typeof initial[], status = 'Complete') => handlers.get('state')!(encodeURIComponent(JSON.stringify({
    status, open: true, conversationId: 1, overlayEnabled: true, phrase: 'hello', cue: 'hello', turns: items,
    settings: { endpoint: '', model: '', sourceLanguage: 'Turkish', explanationLanguage: 'English',
      includeSecondary: true, noKeyRequired: false, hasSavedKey: false, requestUrl: '' }
  })));
  state([initial]);
  expect(turns.scrollTop).toBe(0); // opening an existing long answer starts at its beginning
  question.value = 'one\ntwo\nthree\nfour';
  question.dispatchEvent(new window.Event('input') as unknown as Event);
  expect(question.style.height).toBe('78px');
  question.value = 'one';
  question.dispatchEvent(new window.Event('input') as unknown as Event);
  expect(question.style.height).toBe('38px');
  const newline = new window.KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, cancelable: true });
  question.dispatchEvent(newline as unknown as Event);
  expect(newline.defaultPrevented).toBe(false);
  const composing = new window.KeyboardEvent('keydown', { key: 'Enter', isComposing: true, cancelable: true });
  question.dispatchEvent(composing as unknown as Event);
  expect(composing.defaultPrevented).toBe(false);
  expect(sent.filter(item => item.name === 'followUp')).toHaveLength(0);
  (window.document.querySelector('#send') as unknown as HTMLButtonElement).click();
  expect(sent.at(-1)).toEqual({ name: 'followUp', data: { question: 'one' } });
  expect(question.value).toBe('');
  state([initial, followUp], 'Generating…');
  expect(turns.scrollTop).toBe(800); // a newly sent question is brought into view
  expect(window.document.querySelector('.user-message')?.textContent).toContain('<img src=x> Why?');
  expect(window.document.querySelector('.user-message img')).toBeNull();
  question.value = 'Keep this draft';
  question.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', cancelable: true }) as unknown as Event);
  expect(sent.filter(item => item.name === 'followUp')).toHaveLength(1);
  expect(question.value).toBe('Keep this draft');
  turns.scrollTop = 0;
  height = 1200;
  state([initial, { ...followUp, answer: 'Partial reply' }], 'Generating…');
  expect(turns.scrollTop).toBe(0); // reading older content is not interrupted by streamed chunks
  turns.scrollTop = 1100;
  state([initial, { ...followUp, answer: 'Partial reply continues' }], 'Generating…');
  expect(turns.scrollTop).toBe(1200);
  window.happyDOM.abort();
});
