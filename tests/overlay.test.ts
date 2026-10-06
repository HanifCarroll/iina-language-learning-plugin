import { test, expect } from 'bun:test';
import { Window } from 'happy-dom';
import { mountOverlay } from '../ui/overlay';

test('clicking a word opens a plain-text card while dragging still selects a phrase', async () => {
  const window = new Window();
  (window as unknown as { SyntaxError: typeof SyntaxError }).SyntaxError = SyntaxError;
  window.document.body.innerHTML = (await Bun.file('ui/overlay.html').text())
    .split('<body>')[1]
    .split('</body>')[0];
  const style = window.document.createElement('style');
  style.textContent = await Bun.file('ui/overlay.css').text();
  window.document.head.append(style);
  const handlers = new Map<string, (data: string) => void>();
  const sent: Array<{ name: string; data: unknown }> = [];
  const cue = window.document.getElementById('cue')!;
  expect(window.getComputedStyle(cue).cursor).toBe('pointer');
  Object.defineProperty(window.document, 'caretRangeFromPoint', {
    value: () => {
      const range = window.document.createRange();
      range.setStart(cue.firstChild!, 5);
      return range;
    }
  });
  mountOverlay(window.document as unknown as Document, {
    onMessage: (name, callback) => {
      handlers.set(name, callback);
    },
    postMessage: (name, data) => {
      sent.push({ name, data });
    }
  });
  handlers.get('cue')!(
    encodeURIComponent(
      JSON.stringify({
        trackId: 1,
        index: 0,
        text: 'Bu davranışı kaldıramam.'
      })
    )
  );

  cue.dispatchEvent(new window.MouseEvent('mousedown', { clientX: 300, clientY: 500 }));
  cue.dispatchEvent(new window.MouseEvent('mouseup', { clientX: 300, clientY: 500 }));
  await Bun.sleep(365);
  expect(sent.find((item) => item.name === 'wordSelected')?.data).toMatchObject({
    offset: 5,
    x: 300,
    y: 500
  });

  handlers.get('wordCard')!(
    encodeURIComponent(
      JSON.stringify({
        word: 'davranışı',
        meaning: '…',
        x: 300,
        y: 500
      })
    )
  );
  handlers.get('wordResult')!(
    encodeURIComponent(
      JSON.stringify({
        word: 'davranışı',
        meaning: '<img src=x>',
        alternatives: ['conduct', 'behavior']
      })
    )
  );
  expect(window.document.getElementById('word-card')!.hasAttribute('hidden')).toBe(false);
  expect(window.document.getElementById('word-card-meaning')!.textContent).toBe('<img src=x>');
  expect(window.document.querySelector('#word-card img')).toBeNull();
  (window.document.getElementById('word-card-close') as unknown as HTMLButtonElement).click();
  expect(sent.at(-1)?.name).toBe('wordClosed');
  window.happyDOM.abort();
});

test('DOM selection survives cue update, while seek clears it', async () => {
  // 1. Mount a synthetic overlay and record host messages.
  const window = new Window();
  (window as unknown as { SyntaxError: typeof SyntaxError }).SyntaxError = SyntaxError;
  window.document.body.innerHTML =
    '<div id="wrap"><div id="translation"></div><div id="source-line"><div id="cue"></div><button id="explain-line" hidden>Explain line</button></div></div>';
  const handlers = new Map<string, (data: string) => void>();
  const sent: string[] = [];
  const state = mountOverlay(window.document as unknown as Document, {
    onMessage: (name, callback) => {
      handlers.set(name, callback);
    },
    postMessage: (name) => {
      sent.push(name);
    }
  });
  const cue = window.document.querySelector('#cue')!;
  handlers.get('cue')!(
    encodeURIComponent(
      JSON.stringify({
        trackId: 1,
        index: 0,
        text: 'Ben öyle\nbir insan mıyım?'
      })
    )
  );

  // 2. Advance the current cue during a drag over the original displayed text.
  cue.dispatchEvent(new window.MouseEvent('mousedown'));
  handlers.get('cue')!(
    encodeURIComponent(
      JSON.stringify({
        trackId: 1,
        index: 1,
        text: 'Next cue'
      })
    )
  );
  const range = window.document.createRange();
  range.setStart(cue.firstChild!, 4);
  range.setEnd(cue.firstChild!, 19);
  window.document.getSelection()!.addRange(range);
  cue.dispatchEvent(new window.MouseEvent('mouseup'));
  cue.dispatchEvent(new window.MouseEvent('dblclick'));
  await Bun.sleep(95);

  expect(cue.textContent).toBe('Ben öyle\nbir insan mıyım?');
  expect(state.pending?.cue.index).toBe(0);
  expect(sent.filter((name) => name === 'selected')).toHaveLength(1);

  // 3. Clear the frozen selection when playback seeks.
  handlers.get('seek')!('');

  expect(state.pending).toBeNull();
  expect(cue.textContent).toBe('Next cue');

  window.happyDOM.abort();
});

test('unmatched subtitle text keeps appearance and cancels selection until a matched cue returns', async () => {
  // 1. Mount the real overlay styles and set independent subtitle sizes.
  const window = new Window();
  (window as unknown as { SyntaxError: typeof SyntaxError }).SyntaxError = SyntaxError;
  window.document.body.innerHTML = (await Bun.file('ui/overlay.html').text())
    .split('<body>')[1]
    .split('</body>')[0];
  const style = window.document.createElement('style');
  style.textContent = await Bun.file('ui/overlay.css').text();
  window.document.head.append(style);
  const handlers = new Map<string, (data: string) => void>();
  const sent: string[] = [];
  const state = mountOverlay(window.document as unknown as Document, {
    onMessage: (name, callback) => handlers.set(name, callback),
    postMessage: (name) => sent.push(name)
  });
  const publish = (name: string, value: unknown) =>
    handlers.get(name)!(encodeURIComponent(JSON.stringify(value)));
  const cue = window.document.getElementById('cue')!;
  const translation = window.document.getElementById('translation')!;
  const button = window.document.getElementById('explain-line')!;
  const matched = { trackId: 1, index: 0, text: 'Matched subtitle' };
  publish('appearance', { sourceSize: 34, translationSize: 26 });
  publish('translation', 'Secondary subtitle');
  publish('cue', matched);
  const sourceSize = window.getComputedStyle(cue).fontSize;
  const secondarySize = window.getComputedStyle(translation).fontSize;
  expect(sourceSize).toBe('34px');
  expect(secondarySize).toBe('26px');

  // 2. A mismatch cancels a pending drag and shows only inert player text.
  cue.dispatchEvent(new window.MouseEvent('mousedown'));
  const range = window.document.createRange();
  range.setStart(cue.firstChild!, 0);
  range.setEnd(cue.firstChild!, 7);
  window.document.getSelection()!.addRange(range);
  cue.dispatchEvent(new window.MouseEvent('mouseup'));
  publish('cue', '<img src=x>Unmatched subtitle');
  await Bun.sleep(95);

  expect(cue.textContent).toBe('<img src=x>Unmatched subtitle');
  expect(cue.querySelector('img')).toBeNull();
  expect(state.displayed).toBeNull();
  expect(state.dragging).toBe(false);
  expect(state.pending).toBeNull();
  expect(window.document.getSelection()!.isCollapsed).toBe(true);
  expect(button.hasAttribute('hidden')).toBe(true);
  expect(cue.getAttribute('data-clickable')).toBe('false');
  window.document.getElementById('source-line')!.setAttribute('data-hovered', 'true');
  expect(window.getComputedStyle(cue).cursor).toBe('default');
  expect(window.getComputedStyle(cue).userSelect).toBe('none');
  expect(window.getComputedStyle(cue).fontSize).toBe(sourceSize);
  expect(window.getComputedStyle(translation).fontSize).toBe(secondarySize);
  expect(translation.textContent).toBe('Secondary subtitle');
  expect(sent).not.toContain('selected');
  expect(sent).not.toContain('wordSelected');

  // 3. Reject oversized text, clear gaps, and resume selection for a matched cue.
  publish('cue', 'x'.repeat(4_001));

  expect(cue.textContent).toBe('<img src=x>Unmatched subtitle');

  publish('cue', null);

  expect(cue.textContent).toBe('');

  publish('cue', matched);

  expect(cue.textContent).toBe(matched.text);
  expect(cue.getAttribute('data-clickable')).toBe('true');
  expect(window.getComputedStyle(cue).cursor).toBe('pointer');
  expect(window.getComputedStyle(cue).fontSize).toBe(sourceSize);
  expect(button.hasAttribute('hidden')).toBe(false);

  (button as unknown as HTMLButtonElement).click();

  expect(sent.filter((name) => name === 'selected')).toHaveLength(1);

  window.happyDOM.abort();
});

test('subtitle order swaps without changing source selection or secondary text', async () => {
  const window = new Window();
  (window as unknown as { SyntaxError: typeof SyntaxError }).SyntaxError = SyntaxError;
  window.document.body.innerHTML =
    '<div id="wrap"><div id="translation"></div><div id="source-line"><div id="cue"></div><button id="explain-line" hidden>Explain line</button></div></div>';
  const style = window.document.createElement('style');
  style.textContent = await Bun.file('ui/overlay.css').text();
  window.document.head.append(style);
  const handlers = new Map<string, (data: string) => void>();
  mountOverlay(window.document as unknown as Document, {
    onMessage: (name, callback) => {
      handlers.set(name, callback);
    },
    postMessage: () => {}
  });
  const wrap = window.document.querySelector('#wrap')!;
  handlers.get('cue')!(
    encodeURIComponent(
      JSON.stringify({
        trackId: 1,
        index: 0,
        text: 'Turkish source'
      })
    )
  );
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
  // 1. Mount the overlay with a source cue and full-line action.
  const window = new Window();
  (window as unknown as { SyntaxError: typeof SyntaxError }).SyntaxError = SyntaxError;
  window.document.body.innerHTML =
    '<div id="wrap"><div id="source-line"><div id="cue"></div><button id="explain-line" hidden>Explain line</button></div></div>';
  const handlers = new Map<string, (data: string) => void>();
  const selections: unknown[] = [];
  mountOverlay(window.document as unknown as Document, {
    onMessage: (name, callback) => {
      handlers.set(name, callback);
    },
    postMessage: (name, data) => {
      if (name === 'selected') {
        selections.push(data);
      }
    }
  });
  const cue = window.document.querySelector('#cue')!;
  const button = window.document.getElementById('explain-line') as unknown as HTMLButtonElement;
  handlers.get('cue')!(
    encodeURIComponent(
      JSON.stringify({
        trackId: 1,
        index: 0,
        text: 'Hesap derken?'
      })
    )
  );

  expect(button.hasAttribute('hidden')).toBe(false);

  // 2. Explain the whole cue and release focus after activation.
  button.focus();

  expect(window.document.activeElement?.id).toBe('explain-line');

  button.click();

  expect(window.document.activeElement?.id).not.toBe('explain-line');
  expect(selections).toEqual([
    {
      cue: {
        trackId: 1,
        index: 0,
        text: 'Hesap derken?'
      },
      start: 0,
      end: 13
    }
  ]);
  expect(button.hasAttribute('hidden')).toBe(true);

  // 3. Verify that dragging still selects only a phrase afterward.
  handlers.get('clear')!('');
  cue.dispatchEvent(new window.MouseEvent('mousedown'));
  const range = window.document.createRange();
  range.setStart(cue.firstChild!, 0);
  range.setEnd(cue.firstChild!, 5);
  window.document.getSelection()!.addRange(range);
  cue.dispatchEvent(new window.MouseEvent('mouseup'));
  await Bun.sleep(95);

  expect(selections.at(-1)).toEqual({
    cue: {
      trackId: 1,
      index: 0,
      text: 'Hesap derken?'
    },
    start: 0,
    end: 5
  });

  window.happyDOM.abort();
});

test('IINA hit tests clear hover when movement passes through to the player', () => {
  const window = new Window();
  (window as unknown as { SyntaxError: typeof SyntaxError }).SyntaxError = SyntaxError;
  window.document.body.innerHTML =
    '<div id="wrap"><div id="source-line"><div id="cue"></div><button id="explain-line" hidden>Explain line</button></div></div>';
  const handlers = new Map<string, (data: string) => void>();
  const sourceLine = window.document.getElementById('source-line')!;
  const cue = window.document.getElementById('cue')!;
  const button = window.document.getElementById('explain-line')!;
  Object.defineProperty(button, 'getBoundingClientRect', {
    value: () => ({ left: 100, right: 200, top: 10, bottom: 30 })
  });
  let pointerTarget: unknown = cue;
  Object.defineProperty(window.document, 'elementFromPoint', { value: () => pointerTarget });
  const bridge = {
    onMessage: (name: string, callback: (data: string) => void) => {
      handlers.set(name, callback);
    },
    postMessage: () => {},
    _hitTest: (x: number, _y: number) =>
      x === 1 ||
      (x >= 100 &&
        x <= 200 &&
        !button.hasAttribute('hidden') &&
        sourceLine.getAttribute('data-hovered') === 'true')
  };
  mountOverlay(window.document as unknown as Document, bridge);
  window.dispatchEvent(new window.Event('load'));
  handlers.get('cue')!(
    encodeURIComponent(
      JSON.stringify({
        trackId: 1,
        index: 0,
        text: 'Hesap derken?'
      })
    )
  );

  expect(bridge._hitTest(1, 1)).toBe(true);
  expect(sourceLine.getAttribute('data-hovered')).toBe('true');

  pointerTarget = sourceLine;

  expect(bridge._hitTest(2, 2)).toBe(false);
  expect(sourceLine.getAttribute('data-hovered')).toBe('true');

  pointerTarget = window.document.body;

  expect(bridge._hitTest(120, 20)).toBe(true);
  expect(sourceLine.getAttribute('data-hovered')).toBe('true');
  expect(bridge._hitTest(94, 20)).toBe(false);
  expect(sourceLine.getAttribute('data-hovered')).toBe('true');
  expect(bridge._hitTest(90, 20)).toBe(false);
  expect(sourceLine.getAttribute('data-hovered')).toBe('false');

  handlers.get('cue')!(encodeURIComponent(JSON.stringify(null)));

  expect(bridge._hitTest(120, 20)).toBe(false);
  expect(sourceLine.getAttribute('data-hovered')).toBe('false');

  window.happyDOM.abort();
});
