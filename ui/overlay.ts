import { SelectionState, type DisplayCue } from '../src/selection';

type Bridge = { onMessage(name: string, callback: (data: string) => void): void; postMessage(name: string, data: unknown): void };
declare const iina: Bridge;

export function mountOverlay(doc: Document, bridge: Bridge): SelectionState {
  const cue = doc.querySelector<HTMLElement>('#cue')!;
  const explainLine = doc.querySelector<HTMLButtonElement>('#explain-line')!;
  const translation = doc.querySelector<HTMLElement>('#translation');
  const wrap = doc.querySelector<HTMLElement>('#wrap');
  const state = new SelectionState();
  let captureTimer: ReturnType<typeof setTimeout> | null = null;

  function render(): void {
    if (cue.textContent !== (state.displayed?.text ?? '')) cue.textContent = state.displayed?.text ?? '';
    explainLine.hidden = !state.displayed?.text.trim() || state.dragging || !!state.pending;
  }

  function dismiss(): void {
    if (captureTimer) clearTimeout(captureTimer);
    captureTimer = null;
    state.dismiss();
    doc.getSelection()?.removeAllRanges();
    render();
    bridge.postMessage('selectionCleared', {});
  }

  function capture(): void {
    const selected = doc.getSelection();
    if (!selected || selected.isCollapsed || selected.rangeCount !== 1) { state.dismiss(); render(); return; }
    const range = selected.getRangeAt(0);
    if (range.startContainer !== cue.firstChild || range.endContainer !== cue.firstChild) {
      state.dismiss(); render(); return;
    }
    const pending = state.finishDrag(range.startOffset, range.endOffset);
    render();
    if (pending) bridge.postMessage('selected', { cue: pending.cue, start: pending.start, end: pending.end });
  }

  function scheduleCapture(): void {
    if (captureTimer) clearTimeout(captureTimer);
    captureTimer = setTimeout(() => { captureTimer = null; capture(); }, 80);
  }

  cue.addEventListener('mousedown', () => { state.beginDrag(); render(); });
  cue.addEventListener('mouseup', scheduleCapture);
  cue.addEventListener('dblclick', scheduleCapture);
  explainLine.addEventListener('click', () => {
    if (explainLine.hidden || !state.displayed) return;

    const pending = state.finishDrag(0, state.displayed.text.length);
    render();
    if (pending) bridge.postMessage('selected', { cue: pending.cue, start: pending.start, end: pending.end });
  });
  bridge.onMessage('cue', encoded => {
    try {
      const next: unknown = JSON.parse(decodeURIComponent(encoded));
      if (next === null) { state.cueChanged(null); render(); return; }
      if (typeof next !== 'object') return;
      const item = next as DisplayCue;
      if (!Number.isInteger(item.trackId) || !Number.isInteger(item.index) ||
        typeof item.text !== 'string' || item.text.length > 4_000) return;
      state.cueChanged(item);
      render();
    } catch { /* malformed host data is ignored */ }
  });
  bridge.onMessage('seek', () => { state.seek(); doc.getSelection()?.removeAllRanges(); render(); });
  bridge.onMessage('clear', dismiss);
  bridge.onMessage('subtitleOrder', encoded => {
    if (!wrap) return;
    try {
      const below: unknown = JSON.parse(decodeURIComponent(encoded));
      if (typeof below === 'boolean') wrap.dataset.secondaryBelowSource = String(below);
    } catch { /* ignore malformed host message */ }
  });
  bridge.onMessage('appearance', encoded => {
    if (!wrap) return;
    try {
      const value = JSON.parse(decodeURIComponent(encoded)) as Record<string, unknown>;
      const numeric = (name: string, min: number, max: number, unit: string, property: string) => {
        const number = value[name];
        if (typeof number === 'number' && Number.isInteger(number) && number >= min && number <= max)
          wrap.style.setProperty(property, `${number}${unit}`);
      };
      numeric('sourceSize', 16, 56, 'px', '--source-size');
      numeric('translationSize', 16, 56, 'px', '--translation-size');
      numeric('sourceBottom', 4, 35, '%', '--source-bottom');
      numeric('translationGap', 0, 80, 'px', '--translation-gap');
      for (const [key, property] of [['sourceColor', '--source-color'], ['translationColor', '--translation-color']]) {
        const color = value[key];
        if (typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color)) wrap.style.setProperty(property, color);
      }
    } catch { /* ignore invalid display settings */ }
  });
  bridge.onMessage('translation', encoded => {
    if (!translation) return;
    try {
      const value: unknown = JSON.parse(decodeURIComponent(encoded));
      translation.textContent = typeof value === 'string' && value.length <= 4_000 ? value : '';
    } catch { translation.textContent = ''; }
  });
  bridge.postMessage('overlayReady', {});
  return state;
}

if (typeof document !== 'undefined' && typeof iina !== 'undefined') mountOverlay(document, iina);
