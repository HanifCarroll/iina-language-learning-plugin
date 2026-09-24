import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { open, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { evalCases, requestFor } from './eval_cases';

// A deliberate local-only command: the key stays in memory and a private FIFO.
// Never print it, place it in argv/environment, or write it to the worksheet.
const mock = Bun.argv[2] === '--mock';
if (!mock && Bun.argv[2] !== '--live') throw new Error('Pass --mock for local transport or --live for billable synthetic eval requests');

const service = 'io.github.hanifcarroll.iina-language-learning - api:https://api.deepseek.com';
const endpoint = mock ? 'http://127.0.0.1:47891/chat/completions' : 'https://api.deepseek.com/chat/completions';
const model = mock ? 'synthetic' : 'deepseek-flash';
const helper = 'dist/io.github.hanifcarroll.iina-language-learning.iinaplugin/native/stream-helper';
const worksheetPath = mock ? '.tmp/eval-collector-mock.json' : '.tmp/eval-review.json';
const worksheet = (mock ? {
  run: { model, promptCommit: '', reviewer: '' },
  results: Object.fromEntries(evalCases.map(item => [item.id, { status: 'not_run', answer: '' }]))
} : JSON.parse(await readFile(worksheetPath, 'utf8'))) as {
  run: { model: string; promptCommit: string; reviewer: string };
  results: Record<string, { status: string; answer: string }>;
};
if (evalCases.some(item => worksheet.results[item.id]?.status !== 'not_run')) {
  throw new Error('The eval worksheet already has attempted cases; preserve it and start a fresh worksheet');
}

async function readKey(): Promise<string> {
  const keyProcess = spawn('security', ['find-generic-password', '-s', service, '-a', 'api-key', '-w'],
    { stdio: ['ignore', 'pipe', 'ignore'] });
  const keyClosed = once(keyProcess, 'close');
  const keyChunks: Buffer[] = [];
  for await (const chunk of keyProcess.stdout) keyChunks.push(Buffer.from(chunk));
  const [keyExit] = await keyClosed as [number];
  if (keyExit !== 0) throw new Error('One-time Keychain read was not granted');
  const key = Buffer.concat(keyChunks).toString('utf8').replace(/\n$/, '');
  if (!key || key.includes('\n') || key.includes('\r')) throw new Error('Saved API key is invalid');
  return key;
}
const key = mock ? 'fixture-eval' : await readKey();

async function runCase(messages: unknown): Promise<{ status: 'complete' | 'incomplete' | 'failed'; answer: string; error?: string }> {
  const parent = await mkdtemp('/tmp/iina-synthetic-eval-');
  const directory = `${parent}/request`;
  const child = spawn(helper, [directory], { stdio: ['ignore', 'pipe', 'ignore'] });
  const closed = once(child, 'close');
  const lines = createInterface({ input: child.stdout });
  const watchdog = setTimeout(() => child.kill('SIGTERM'), 130_000);
  let control: Awaited<ReturnType<typeof open>> | null = null;
  let answer = '';
  let terminal: 'complete' | 'incomplete' | 'failed' | null = null;
  let failure: string | undefined;
  try {
    for await (const line of lines) {
      if (line === 'READY') {
        control = await open(`${directory}/control`, 'w');
        const input = await open(`${directory}/request`, 'w');
        try {
          await input.writeFile(JSON.stringify({ url: endpoint, key,
            body: { model, stream: true, messages } }));
        } finally { await input.close(); }
      } else if (line.startsWith('DELTA ')) {
        answer += Buffer.from(line.slice(6), 'base64').toString('utf8');
      } else if (line === 'DONE') terminal = 'complete';
      else if (line.startsWith('ERROR ') || line.startsWith('CANCELLED ')) {
        terminal = answer ? 'incomplete' : 'failed';
        failure = line;
      }
    }
    await closed;
  } catch (error) {
    child.kill('SIGTERM');
    await closed;
    throw error;
  } finally {
    clearTimeout(watchdog);
    await control?.close();
    await rm(parent, { recursive: true, force: true });
  }
  return { status: terminal ?? (answer ? 'incomplete' : 'failed'), answer, error: failure };
}

for (const item of evalCases) {
  const result = await runCase(requestFor(item).messages);
  worksheet.results[item.id].status = result.status;
  worksheet.results[item.id].answer = result.answer;
  await writeFile(worksheetPath, JSON.stringify(worksheet, null, 2) + '\n');
  console.log(`${item.id} ${result.status}${result.error ? ` ${result.error}` : ''}`);
  if (result.status !== 'complete') break;
}
