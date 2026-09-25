import { mkdir } from 'node:fs/promises';
import { evalCases, requestFor, type EvalCase } from './eval_cases';

export type Verdict = 'PASS' | 'FAIL' | 'INCOMPLETE' | 'NOT_RUN';
export type ReviewItem = {
  status: 'not_run' | 'complete' | 'incomplete' | 'failed';
  answer?: string;
  scores?: number[];
  checks?: Record<string, boolean>;
  blockers?: string[];
  rationale?: string;
};

export function grade(
  item: EvalCase,
  review?: ReviewItem
): {
  verdict: Verdict;
  reasons: string[];
} {
  // 1. Distinguish missing and incomplete runs from completed answers.
  if (!review || review.status === 'not_run') {
    return { verdict: 'NOT_RUN', reasons: [] };
  }

  if (review.status !== 'complete') {
    return { verdict: 'INCOMPLETE', reasons: [review.status] };
  }

  // 2. Check required sections, rubric scores, and case-specific criteria.
  const reasons: string[] = [];
  const answer = review.answer ?? '';
  if (!answer.trim()) {
    reasons.push('empty answer');
  }
  if (!item.question && !/\bnatural meaning\b/i.test(answer)) {
    reasons.push('missing Natural meaning');
  }
  if (!item.question && !/\bliteral meaning\b/i.test(answer)) {
    reasons.push('missing Literal meaning');
  }
  const dimensions = item.question ? 3 : 5;
  if (
    !Array.isArray(review.scores) ||
    review.scores.length !== dimensions ||
    review.scores.some((score) => !Number.isInteger(score) || score < 0 || score > 2)
  ) {
    reasons.push('invalid rubric scores');
  } else if (
    review.scores.some((score) => score === 0) ||
    review.scores.reduce((sum, score) => sum + score, 0) < (item.question ? 5 : 8)
  ) {
    reasons.push('rubric below pass threshold');
  }
  for (const key of Object.keys(item.checks)) {
    if (review.checks?.[key] !== true) {
      reasons.push(`criterion ${key} not met`);
    }
  }

  // 3. Require explicit blocker review and a human rationale.
  if (!Array.isArray(review.blockers)) {
    reasons.push('blocking-failure review missing');
  } else if (review.blockers.length) {
    reasons.push('blocking failure reported');
  }
  if (!review.rationale?.trim()) {
    reasons.push('review rationale missing');
  }

  return { verdict: reasons.length ? 'FAIL' : 'PASS', reasons };
}

async function main(): Promise<void> {
  // 1. Validate every case through production prompt assembly.
  for (const item of evalCases) {
    requestFor(item);
  } // fail before reporting if a synthetic case cannot use production prompt assembly

  // 2. Create a review worksheet only when none already exists.
  if (Bun.argv[2] === '--template') {
    const path = '.tmp/eval-review.json';
    await mkdir('.tmp', { recursive: true });
    if (await Bun.file(path).exists()) {
      console.error(`${path} already exists; keep the existing reviews`);
      process.exitCode = 2;

      return;
    }

    const template = {
      run: {
        model: '',
        promptCommit: '',
        reviewer: ''
      },
      results: Object.fromEntries(
        evalCases.map((item) => [
          item.id,
          {
            status: 'not_run',
            answer: '',
            scores: Array(item.question ? 3 : 5).fill(null),
            checks: Object.fromEntries(Object.keys(item.checks).map((key) => [key, false])),
            blockers: [],
            rationale: ''
          }
        ])
      )
    };
    await Bun.write(path, JSON.stringify(template, null, 2) + '\n');
    console.log(`Wrote ${path}; keep completed answers and reviews in this ignored file.`);

    return;
  }

  // 3. Validate run provenance before grading recorded answers.
  const path = Bun.argv[2];
  const input = path
    ? ((await Bun.file(path).json()) as {
        run?: {
          model?: string;
          promptCommit?: string;
          reviewer?: string;
        };
        results?: Record<string, ReviewItem>;
      })
    : null;
  const attempted = Object.values(input?.results ?? {}).some(
    (result) => result.status !== 'not_run'
  );
  if (
    attempted &&
    (!input?.run?.model?.trim() ||
      !/^[0-9a-f]{7,40}$/i.test(input.run.promptCommit ?? '') ||
      !input.run.reviewer?.trim())
  ) {
    console.error('Record model, prompt commit, and reviewer before grading completed answers');
    process.exitCode = 2;

    return;
  }

  // 4. Report each verdict and set a failing exit status when needed.
  let failed = 0;
  for (const item of evalCases) {
    const result = grade(item, input?.results?.[item.id]);
    if (result.verdict !== 'PASS') {
      failed++;
    }
    console.log(
      `${item.id} ${result.verdict} ${item.title}${result.reasons.length ? ` — ${result.reasons.join('; ')}` : ''}`
    );
  }
  console.log(
    `${evalCases.length - failed}/${evalCases.length} passed${path ? '' : ' (no model responses supplied)'}`
  );
  if (failed) {
    process.exitCode = path ? 1 : 2;
  }
}

if (import.meta.main) {
  await main();
}
