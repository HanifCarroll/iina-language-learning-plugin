import { test, expect } from 'bun:test';
import { SelectionState } from '../src/selection';

const first = {
  trackId: 1,
  index: 2,
  text: 'Ben öyle\nbir insan mıyım?'
};
const second = {
  trackId: 1,
  index: 3,
  text: 'Next line'
};

test('natural cue advance during drag keeps original cue and pending phrase', () => {
  const state = new SelectionState();
  state.cueChanged(first);
  state.beginDrag();
  state.cueChanged(second);

  expect(state.displayed).toBe(first);
  expect(state.finishDrag(4, 19)).toEqual({
    cue: first,
    start: 4,
    end: 19,
    text: first.text.slice(4, 19)
  });

  state.cueChanged(null);

  expect(state.pending?.cue).toBe(first);

  state.dismiss();

  expect(state.displayed).toBeNull();
});

test('user seek clears an uninvoked selection, including active drag', () => {
  const state = new SelectionState();
  state.cueChanged(first);
  state.finishDrag(4, 8);
  state.cueChanged(second);

  expect(state.pending?.text).toBe('öyle');

  state.seek();

  expect(state.pending).toBeNull();
  expect(state.displayed).toBe(second);

  state.beginDrag();
  state.cueChanged(first);
  state.seek();

  expect(state.dragging).toBe(false);
  expect(state.displayed).toBe(first);
});
