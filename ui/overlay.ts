import { SelectionState, type DisplayCue } from '../src/selection';

type Bridge = {
  onMessage(name: string, callback: (data: string) => void): void;
  postMessage(name: string, data: unknown): void;
  _hitTest?: (x: number, y: number) => boolean;
};
declare const iina: Bridge;

export function mountOverlay(doc: Document, bridge: Bridge): SelectionState {
  // 1. Bind the overlay elements and its selection state.
  const cue = doc.querySelector<HTMLElement>('#cue')!;
  const explainLine = doc.querySelector<HTMLButtonElement>('#explain-line')!;
  const sourceLine = doc.querySelector<HTMLElement>('#source-line')!;
  const translation = doc.querySelector<HTMLElement>('#translation');
  const wrap = doc.querySelector<HTMLElement>('#wrap');
  const wordCard = doc.querySelector<HTMLElement>('#word-card');
  const wordCardWord = doc.querySelector<HTMLElement>('#word-card-word');
  const wordCardMeaning = doc.querySelector<HTMLElement>('#word-card-meaning');
  const wordCardAlternatives = doc.querySelector<HTMLElement>('#word-card-alternatives');
  const wordCardAlternativeList = doc.querySelector<HTMLElement>('#word-card-alternative-list');
  const wordCardClose = doc.querySelector<HTMLButtonElement>('#word-card-close');
  const state = new SelectionState();
  let captureTimer: ReturnType<typeof setTimeout> | null = null;
  let wordTimer: ReturnType<typeof setTimeout> | null = null;

  function installHoverTracking(): void {
    const nativeHitTest = bridge._hitTest;
    if (!nativeHitTest) {
      return;
    }

    // IINA passes movement outside clickable elements to the player, leaving WebView :hover stale.
    bridge._hitTest = (x, y) => {
      const buttonBounds = explainLine.getBoundingClientRect();
      const nearButton =
        !explainLine.hidden &&
        x >= buttonBounds.left - 8 &&
        x <= buttonBounds.right + 8 &&
        y >= buttonBounds.top - 8 &&
        y <= buttonBounds.bottom + 8;
      sourceLine.dataset.hovered = String(
        sourceLine.contains(doc.elementFromPoint(x, y)) || nearButton
      );

      return nativeHitTest(x, y);
    };
  }

  if (doc.readyState === 'complete') {
    installHoverTracking();
  } else {
    doc.defaultView?.addEventListener('load', installHoverTracking, { once: true });
  }

  function render(): void {
    if (cue.textContent !== (state.displayed?.text ?? '')) {
      cue.textContent = state.displayed?.text ?? '';
    }
    explainLine.hidden = !state.displayed?.text.trim() || state.dragging || !!state.pending;
  }

  function dismiss(): void {
    if (captureTimer) {
      clearTimeout(captureTimer);
    }
    captureTimer = null;
    if (wordTimer) {
      clearTimeout(wordTimer);
    }
    wordTimer = null;
    if (wordCard) {
      wordCard.hidden = true;
    }
    state.dismiss();
    sourceLine.dataset.hovered = 'false';
    doc.getSelection()?.removeAllRanges();
    render();
    bridge.postMessage('selectionCleared', {});
  }

  function capture(): void {
    // 1. Accept only a single range inside the source cue text.
    const selected = doc.getSelection();
    if (!selected || selected.isCollapsed || selected.rangeCount !== 1) {
      state.dismiss();
      render();

      return;
    }

    const range = selected.getRangeAt(0);
    if (range.startContainer !== cue.firstChild || range.endContainer !== cue.firstChild) {
      state.dismiss();
      render();

      return;
    }

    // 2. Freeze the accepted range and submit it for host validation.
    const pending = state.finishDrag(range.startOffset, range.endOffset);
    render();
    if (pending) {
      bridge.postMessage('selected', {
        cue: pending.cue,
        start: pending.start,
        end: pending.end
      });
    }
  }

  function scheduleCapture(): void {
    if (captureTimer) {
      clearTimeout(captureTimer);
    }
    captureTimer = setTimeout(() => {
      captureTimer = null;
      capture();
    }, 80);
  }

  function scheduleWord(event: MouseEvent): void {
    if (wordTimer) {
      clearTimeout(wordTimer);
    }
    const x = event.clientX;
    const y = event.clientY;
    const displayed = state.displayed;
    wordTimer = setTimeout(() => {
      wordTimer = null;
      state.dismiss();
      render();
      const documentWithCaret = doc as Document & {
        caretRangeFromPoint?: (x: number, y: number) => Range | null;
      };
      const range = documentWithCaret.caretRangeFromPoint?.(x, y);
      if (!displayed || !range || range.startContainer !== cue.firstChild) {
        return;
      }

      bridge.postMessage('wordSelected', {
        cue: displayed,
        offset: range.startOffset,
        x,
        y
      });
    }, 350);
  }

  // 2. Capture phrase selections and the full-line action.
  cue.addEventListener('mousedown', () => {
    state.beginDrag();
    render();
  });
  cue.addEventListener('mouseup', (event) => {
    const selection = doc.getSelection();
    if (selection && !selection.isCollapsed) {
      scheduleCapture();
    } else {
      scheduleWord(event);
    }
  });
  cue.addEventListener('dblclick', () => {
    if (wordTimer) {
      clearTimeout(wordTimer);
    }
    wordTimer = null;
    scheduleCapture();
  });
  explainLine.addEventListener('click', () => {
    if (explainLine.hidden || !state.displayed) {
      return;
    }

    // IINA passes outside clicks through the overlay, so they cannot clear button focus.
    explainLine.blur();
    const pending = state.finishDrag(0, state.displayed.text.length);
    render();
    if (pending) {
      bridge.postMessage('selected', {
        cue: pending.cue,
        start: pending.start,
        end: pending.end
      });
    }
  });
  wordCardClose?.addEventListener('click', () => bridge.postMessage('wordClosed', {}));
  doc.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && wordCard && !wordCard.hidden) {
      bridge.postMessage('wordClosed', {});
    }
  });

  // 3. Validate player messages before updating subtitle content or appearance.
  bridge.onMessage('cue', (encoded) => {
    try {
      const next: unknown = JSON.parse(decodeURIComponent(encoded));
      if (next === null) {
        state.cueChanged(null);
        sourceLine.dataset.hovered = 'false';
        render();

        return;
      }

      if (typeof next !== 'object') {
        return;
      }

      const item = next as DisplayCue;
      if (
        !Number.isInteger(item.trackId) ||
        !Number.isInteger(item.index) ||
        typeof item.text !== 'string' ||
        item.text.length > 4_000
      ) {
        return;
      }

      state.cueChanged(item);
      sourceLine.dataset.hovered = 'false';
      render();
    } catch {
      /* malformed host data is ignored */
    }
  });
  bridge.onMessage('seek', () => {
    state.seek();
    sourceLine.dataset.hovered = 'false';
    doc.getSelection()?.removeAllRanges();
    render();
  });
  bridge.onMessage('clear', dismiss);
  bridge.onMessage('wordCard', (encoded) => {
    if (!wordCard || !wordCardWord || !wordCardMeaning || !wordCardAlternatives) {
      return;
    }
    try {
      const value: unknown = JSON.parse(decodeURIComponent(encoded));
      if (value === null) {
        wordCard.hidden = true;
        return;
      }
      if (!value || typeof value !== 'object') {
        return;
      }

      const card = value as { word?: unknown; meaning?: unknown; x?: unknown; y?: unknown };
      if (
        typeof card.word !== 'string' ||
        card.word.length > 100 ||
        typeof card.meaning !== 'string' ||
        card.meaning.length > 250 ||
        typeof card.x !== 'number' ||
        typeof card.y !== 'number'
      ) {
        return;
      }

      wordCardWord.textContent = card.word;
      wordCardMeaning.textContent = card.meaning;
      wordCardAlternatives.hidden = true;
      const width = doc.defaultView?.innerWidth ?? 800;
      const height = doc.defaultView?.innerHeight ?? 600;
      wordCard.style.left = `${Math.max(12, Math.min(card.x - 100, width - 296))}px`;
      wordCard.style.top = `${Math.max(12, Math.min(card.y < 210 ? card.y + 24 : card.y - 176, height - 220))}px`;
      wordCard.hidden = false;
    } catch {
      /* ignore malformed host state */
    }
  });
  bridge.onMessage('wordResult', (encoded) => {
    if (
      !wordCard ||
      wordCard.hidden ||
      !wordCardMeaning ||
      !wordCardAlternatives ||
      !wordCardAlternativeList
    ) {
      return;
    }
    try {
      const value = JSON.parse(decodeURIComponent(encoded)) as {
        meaning?: unknown;
        alternatives?: unknown;
      };
      if (
        typeof value.meaning !== 'string' ||
        value.meaning.length > 250 ||
        !Array.isArray(value.alternatives)
      ) {
        return;
      }
      const alternatives = value.alternatives
        .filter((item): item is string => typeof item === 'string' && item.length <= 200)
        .slice(0, 4);
      wordCardMeaning.textContent = value.meaning;
      wordCardAlternativeList.textContent = alternatives.join(' · ');
      wordCardAlternatives.hidden = alternatives.length === 0;
    } catch {
      /* ignore malformed host state */
    }
  });
  bridge.onMessage('subtitleOrder', (encoded) => {
    if (!wrap) {
      return;
    }

    try {
      const below: unknown = JSON.parse(decodeURIComponent(encoded));
      if (typeof below === 'boolean') {
        wrap.dataset.secondaryBelowSource = String(below);
      }
    } catch {
      /* ignore malformed host message */
    }
  });
  bridge.onMessage('appearance', (encoded) => {
    if (!wrap) {
      return;
    }

    try {
      const value = JSON.parse(decodeURIComponent(encoded)) as Record<string, unknown>;
      const numeric = (name: string, min: number, max: number, unit: string, property: string) => {
        const number = value[name];
        if (
          typeof number === 'number' &&
          Number.isInteger(number) &&
          number >= min &&
          number <= max
        ) {
          wrap.style.setProperty(property, `${number}${unit}`);
        }
      };
      numeric('sourceSize', 16, 56, 'px', '--source-size');
      numeric('translationSize', 16, 56, 'px', '--translation-size');
      numeric('sourceBottom', 4, 35, '%', '--source-bottom');
      numeric('translationGap', 0, 80, 'px', '--translation-gap');
      for (const [key, property] of [
        ['sourceColor', '--source-color'],
        ['translationColor', '--translation-color']
      ]) {
        const color = value[key];
        if (typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color)) {
          wrap.style.setProperty(property, color);
        }
      }
    } catch {
      /* ignore invalid display settings */
    }
  });
  bridge.onMessage('translation', (encoded) => {
    if (!translation) {
      return;
    }

    try {
      const value: unknown = JSON.parse(decodeURIComponent(encoded));
      translation.textContent = typeof value === 'string' && value.length <= 4_000 ? value : '';
    } catch {
      translation.textContent = '';
    }
  });

  // 4. Notify the player after all message handlers are registered.
  bridge.postMessage('overlayReady', {});

  return state;
}

if (typeof document !== 'undefined' && typeof iina !== 'undefined') {
  mountOverlay(document, iina);
}
