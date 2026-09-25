import { test, expect } from 'bun:test';
import { Window } from 'happy-dom';
import { mountOverlay } from '../ui/overlay';

test('DOM selection survives cue update, while seek clears it', async () => {
  const window = new Window();
  (window as unknown as { SyntaxError: typeof SyntaxError }).SyntaxError = SyntaxError;
  window.document.body.innerHTML = '<div id="wrap"><div id="translation"></div><div id="source-line"><div id="cue"></div><button id="explain-line" hidden>Explain line</button></div></div>';
  const handlers = new Map<string, (data: string) => void>();
  const sent: string[] = [];
  const state = mountOverlay(window.document as unknown as Document, { onMessage: (name, callback) => { handlers.set(name, callback); }, postMessage: name => { sent.push(name); } });
  const cue = window.document.querySelector('#cue')!;
  handlers.get('cue')!(encodeURIComponent(JSON.stringify({ trackId: 1, index: 0, text: 'Ben öyle\nbir insan mıyım?' })));
  cue.dispatchEvent(new window.MouseEvent('mousedown'));
  handlers.get('cue')!(encodeURIComponent(JSON.stringify({ trackId: 1, index: 1, text: 'Next cue' })));
  const range = window.document.createRange();
  range.setStart(cue.firstChild!, 4);
  range.setEnd(cue.firstChild!, 19);
  window.document.getSelection()!.addRange(range);
  cue.dispatchEvent(new window.MouseEvent('mouseup'));
  cue.dispatchEvent(new window.MouseEvent('dblclick'));
  await Bun.sleep(95);
  expect(cue.textContent).toBe('Ben öyle\nbir insan mıyım?');
  expect(state.pending?.cue.index).toBe(0);
  expect(sent.filter(name => name === 'selected')).toHaveLength(1);
  handlers.get('seek')!('');
  expect(state.pending).toBeNull();
  expect(cue.textContent).toBe('Next cue');
  window.happyDOM.abort();
});

test('subtitle order swaps without changing source selection or secondary text', async () => {
  const window = new Window();
  (window as unknown as { SyntaxError: typeof SyntaxError }).SyntaxError = SyntaxError;
  window.document.body.innerHTML = '<div id="wrap"><div id="translation"></div><div id="source-line"><div id="cue"></div><button id="explain-line" hidden>Explain line</button></div></div>';
  const style = window.document.createElement('style');
  style.textContent = await Bun.file('ui/overlay.css').text();
  window.document.head.append(style);
  const handlers = new Map<string, (data: string) => void>();
  mountOverlay(window.document as unknown as Document, {
    onMessage: (name, callback) => { handlers.set(name, callback); }, postMessage: () => {}
  });
  const wrap = window.document.querySelector('#wrap')!;
  handlers.get('cue')!(encodeURIComponent(JSON.stringify({ trackId: 1, index: 0, text: 'Turkish source' })));
  handlers.get('translation')!(encodeURIComponent(JSON.stringify('English secondary')));
  handlers.get('subtitleOrder')!(encodeURIComponent(JSON.stringify(true)));
  expect(wrap.getAttribute('data-secondary-below-source')).toBe('true');
  expect(window.getComputedStyle(wrap).flexDirection).toBe('column-reverse');
  expect(window.document.querySelector('#cue')?.textContent).toBe('Turkish source');
  expect(window.document.querySelector('#translation')?.textContent).toBe('English secondary');
  handlers.get('subtitleOrder')!(encodeURIComponent(JSON.stringify(false)));
  expect(wrap.getAttribute('data-secondary-below-source')).toBe('false');
  window.happyDOM.abort();
});

test('hover action selects the whole source cue without replacing phrase selection', async () => {
  const window = new Window();
  (window as unknown as { SyntaxError: typeof SyntaxError }).SyntaxError = SyntaxError;
  window.document.body.innerHTML = '<div id="wrap"><div id="source-line"><div id="cue"></div><button id="explain-line" hidden>Explain line</button></div></div>';
  const handlers = new Map<string, (data: string) => void>();
  const selections: unknown[] = [];
  mountOverlay(window.document as unknown as Document, {
    onMessage: (name, callback) => { handlers.set(name, callback); },
    postMessage: (name, data) => { if (name === 'selected') selections.push(data); }
  });
  const cue = window.document.querySelector('#cue')!;
  const button = window.document.querySelector('#explain-line')!;
  handlers.get('cue')!(encodeURIComponent(JSON.stringify({ trackId: 1, index: 0, text: 'Hesap derken?' })));
  expect(button.hasAttribute('hidden')).toBe(false);
  button.dispatchEvent(new window.MouseEvent('click'));
  expect(selections).toEqual([{ cue: { trackId: 1, index: 0, text: 'Hesap derken?' }, start: 0, end: 13 }]);
  expect(button.hasAttribute('hidden')).toBe(true);

  handlers.get('clear')!('');
  cue.dispatchEvent(new window.MouseEvent('mousedown'));
  const range = window.document.createRange();
  range.setStart(cue.firstChild!, 0);
  range.setEnd(cue.firstChild!, 5);
  window.document.getSelection()!.addRange(range);
  cue.dispatchEvent(new window.MouseEvent('mouseup'));
  await Bun.sleep(95);
  expect(selections.at(-1)).toEqual({ cue: { trackId: 1, index: 0, text: 'Hesap derken?' }, start: 0, end: 5 });
  window.happyDOM.abort();
});
