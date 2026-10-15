import { canonicalEndpoint } from './credentials';

export const LUNA_ENDPOINT = 'https://api.openai.com/v1';
export const LUNA_MODEL = 'gpt-6-luna';
export const DEEPSEEK_WAIT_MS = 5_000;

export function isDeepSeekEndpoint(endpoint: string): boolean {
  return /^https:\/\/api\.deepseek\.com(?:\/|$)/.test(canonicalEndpoint(endpoint).base);
}

export class FallbackDeadline {
  private firstAnswerReceived = false;

  constructor(private readonly startedAt: number) {}

  receiveAnswer(text: string): void {
    if (text.trim()) {
      this.firstAnswerReceived = true;
    }
  }

  isDue(now: number): boolean {
    return this.isWaiting() && now - this.startedAt >= DEEPSEEK_WAIT_MS;
  }

  isWaiting(): boolean {
    return !this.firstAnswerReceived;
  }
}
