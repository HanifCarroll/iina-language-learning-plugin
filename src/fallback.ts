import { canonicalEndpoint } from './credentials';

export const LUNA_ENDPOINT = 'https://api.openai.com/v1';
export const LUNA_MODEL = 'gpt-6-luna';
export const FALLBACK_WAIT_MS = 5_000;
export type ProviderChoice = 'configured' | 'luna';
export type ProviderSettings = {
  endpoint: string;
  model: string;
  noKeyRequired: boolean;
  primaryProvider: ProviderChoice;
};

export function otherProvider(provider: ProviderChoice): ProviderChoice {
  return provider === 'luna' ? 'configured' : 'luna';
}

export function providerConnection(settings: ProviderSettings, provider: ProviderChoice) {
  if (provider === 'luna') {
    return {
      endpoint: LUNA_ENDPOINT,
      model: LUNA_MODEL,
      noKeyRequired: false,
      label: 'GPT-6 Luna'
    };
  }

  return {
    endpoint: settings.endpoint,
    model: settings.model,
    noKeyRequired: settings.noKeyRequired,
    label: isDeepSeekEndpoint(settings.endpoint)
      ? 'DeepSeek'
      : settings.model || 'Configured provider'
  };
}

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
    return this.isWaiting() && now - this.startedAt >= FALLBACK_WAIT_MS;
  }

  isWaiting(): boolean {
    return !this.firstAnswerReceived;
  }
}
