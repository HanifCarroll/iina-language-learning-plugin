import { test, expect } from 'bun:test';
import { Conversation, type ContextSnapshot } from '../src/conversation';

const context: ContextSnapshot = {
  selection: { mediaEpoch: 7, sourceTrackId: 1, cueIndex: 2, cueStartMs: 4000, cueEndMs: 6000,
    cueText: 'Ben öyle bir insan mıyım?', rangeStartUtf16: 4, rangeEndUtf16: 9, exactText: 'öyle ' },
  before: [], after: [{ index: 3, startMs: 7000, endMs: 8000, text: 'Future line' }], secondary: [],
  sourceLanguage: 'Turkish', explanationLanguage: 'English'
};

test('initial, follow-up, retry, and stale response ownership', () => {
  const conversation = new Conversation(3, context);
  const first = conversation.beginInitial();
  expect(first.messages[0].content).toContain('Natural meaning');
  expect(first.messages[1].content).toContain('Future line');
  expect(JSON.parse(first.messages[1].content).task).toBeUndefined();
  expect(conversation.delta(first.owner, 'Natural meaning: such')).toBe(true);
  expect(conversation.complete(first.owner)).toBe(true);
  const followup = conversation.followUp('Why is bir used here?');
  expect(followup.messages.map(m => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
  expect(followup.messages.at(-1)?.content).toBe('Why is bir used here?');
  conversation.delta(followup.owner, 'Part');
  conversation.fail(followup.owner, 'interrupted');
  expect(conversation.turns[1].status).toBe('incomplete');
  const retry = conversation.retry();
  expect(retry.messages.at(-1)?.content).toBe('Why is bir used here?');
  expect(conversation.delta(followup.owner, 'STALE')).toBe(false);
  expect(conversation.delta({ ...retry.owner, mediaEpoch: 8 }, 'STALE')).toBe(false);
  conversation.delta(retry.owner, 'Because it is an article.');
  expect(conversation.complete(retry.owner)).toBe(true);
  expect(conversation.turns[1].answer).toBe('Because it is an article.');
});

test('a stopped turn is incomplete and keeps its original context through media time changes', () => {
  const conversation = new Conversation(4, context);
  const { owner } = conversation.beginInitial();
  conversation.delta(owner, 'partial');
  expect(conversation.stop()).toEqual(owner);
  expect(conversation.turns[0].status).toBe('incomplete');
  expect(conversation.context.selection.cueText).toBe('Ben öyle bir insan mıyım?');
  expect(conversation.delta(owner, 'late')).toBe(false);
});
