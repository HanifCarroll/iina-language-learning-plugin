import { SelectionState, type DisplayCue } from '../src/selection';

type Bridge = { onMessage(name: string, callback: (data: string) => void): void; postMessage(name: string, data: unknown): void };
declare const iina: Bridge;

export function mountOverlay(doc: Document, bridge: Bridge): SelectionState {
  const cue = doc.querySelector<HTMLElement>('#cue')!;
  const actions = doc.querySelector<HTMLElement>('#actions')!;
  const state = new SelectionState();

  function render(): void {
    if (cue.textContent !== (state.displayed?.text ?? '')) cue.textContent = state.displayed?.text ?? '';
    actions.hidden = !state.pending;
  }

  function dismiss(): void {
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

  cue.addEventListener('mousedown', () => state.beginDrag());
  cue.addEventListener('mouseup', () => setTimeout(capture, 0));
  cue.addEventListener('dblclick', () => setTimeout(capture, 0));
  doc.querySelector('#explain')!.addEventListener('click', () => {
    if (state.pending) bridge.postMessage('explain', state.pending);
  });
  doc.querySelector('#clear')!.addEventListener('click', dismiss);
  bridge.onMessage('cue', encoded => {
    try {
      const next: unknown = JSON.parse(decodeURIComponent(encoded));
      if (!next || typeof next !== 'object') return;
      const item = next as DisplayCue;
      if (!Number.isInteger(item.trackId) || !Number.isInteger(item.index) ||
        typeof item.text !== 'string' || item.text.length > 4_000) return;
      state.cueChanged(item);
      render();
    } catch { /* malformed host data is ignored */ }
  });
  bridge.onMessage('seek', () => { state.seek(); doc.getSelection()?.removeAllRanges(); render(); });
  bridge.onMessage('clear', dismiss);
  bridge.postMessage('overlayReady', {});
  return state;
}

if (typeof document !== 'undefined' && typeof iina !== 'undefined') mountOverlay(document, iina);
