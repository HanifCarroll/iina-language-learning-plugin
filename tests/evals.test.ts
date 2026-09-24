import { expect, test } from 'bun:test';
import { evalCases, requestFor } from './eval_cases';
import { grade, type ReviewItem } from './eval_runner';

for (const item of evalCases) {
  test(`${item.id} synthetic prompt uses the production conversation path`, () => {
    const { context, messages } = requestFor(item);
    expect(context.selection.exactText).toBe(item.selected);
    expect(context.selection.cueText.slice(context.selection.rangeStartUtf16, context.selection.rangeEndUtf16)).toBe(item.selected);
    const source = JSON.parse(messages[1].content) as {
      selected: string; sourceCue: string; before: string[]; after: string[]; secondary: string[];
    };
    expect(source).toMatchObject({ selected: item.selected, sourceCue: item.cue,
      before: item.before ?? [], after: item.after ?? [], secondary: item.secondary ?? [] });
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).not.toContain(item.cue);
    if (item.question) {
      expect(messages.map(message => message.role)).toEqual(['system', 'user', 'assistant', 'user']);
      expect(messages.at(-1)?.content).toBe(item.question);
      expect(messages[2].content).toBe(item.priorAnswer!);
    } else expect(messages).toHaveLength(2);
  });
}

test('pass/fail grader requires completed text, all case criteria, rubric threshold, and human rationale', () => {
  const item = evalCases[0];
  const passing: ReviewItem = { status: 'complete', answer: '**Natural meaning** Am I that kind of person?\n\n**Literal meaning** Am I such a person?',
    scores: [2, 2, 2, 1, 1], checks: Object.fromEntries(Object.keys(item.checks).map(key => [key, true])),
    blockers: [], rationale: 'Question morphology and whole-cue meaning are explained.' };
  expect(grade(item, passing).verdict).toBe('PASS');
  expect(grade(item, { ...passing, answer: 'A fluent but unlabeled answer.' }).verdict).toBe('FAIL');
  expect(grade(item, { ...passing, scores: [2, 2, 2, 1, 0] }).verdict).toBe('FAIL');
  expect(grade(item, { ...passing, checks: {} }).verdict).toBe('FAIL');
  expect(grade(item, { ...passing, blockers: ['invented plot fact'] }).verdict).toBe('FAIL');
  expect(grade(item, { ...passing, status: 'incomplete' }).verdict).toBe('INCOMPLETE');
  expect(grade(item).verdict).toBe('NOT_RUN');
});

test('follow-up grading does not require repeated initial headings', () => {
  const item = evalCases.find(candidate => candidate.id === 'E12')!;
  expect(grade(item, { status: 'complete', answer: 'Here bir marks an indefinite person, rather than the number one.',
    scores: [2, 2, 1], checks: Object.fromEntries(Object.keys(item.checks).map(key => [key, true])),
    blockers: [], rationale: 'Direct answer tied to the original phrase.' }).verdict).toBe('PASS');
});
