export type WordProvider = 'off' | 'google' | 'microsoft';

export type WordCard = {
  word: string;
  meaning: string;
  alternatives: string[];
};

const LANGUAGE_CODES: Record<string, string> = {
  arabic: 'ar',
  chinese: 'zh',
  dutch: 'nl',
  english: 'en',
  french: 'fr',
  german: 'de',
  greek: 'el',
  hindi: 'hi',
  indonesian: 'id',
  italian: 'it',
  japanese: 'ja',
  korean: 'ko',
  polish: 'pl',
  portuguese: 'pt',
  russian: 'ru',
  spanish: 'es',
  swedish: 'sv',
  turkish: 'tr',
  ukrainian: 'uk',
  vietnamese: 'vi'
};

export function languageCode(language: string): string {
  const normalized = language.trim().toLowerCase();
  const code = LANGUAGE_CODES[normalized] ?? normalized;
  if (!/^[a-z]{2,3}(?:-[a-z]{2,4})?$/.test(code)) {
    throw new Error('Use a language name or ISO language code in AI settings');
  }

  return code;
}

export function wordAt(
  text: string,
  offset: number
): { start: number; end: number; word: string } | null {
  if (!Number.isInteger(offset) || offset < 0 || offset > text.length) {
    return null;
  }

  const isLetter = (value: string) => /[\p{L}\p{M}\p{N}]/u.test(value);
  let start = offset;
  if (!isLetter(text[start] ?? '') && start > 0 && isLetter(text[start - 1])) {
    start--;
  }
  if (!isLetter(text[start] ?? '')) {
    return null;
  }

  let end = start + 1;
  while (start > 0 && isLetter(text[start - 1])) {
    start--;
  }
  while (end < text.length && isLetter(text[end])) {
    end++;
  }

  return { start, end, word: text.slice(start, end) };
}

export function parseWordResponse(
  provider: Exclude<WordProvider, 'off'>,
  kind: 'dictionary' | 'translate',
  raw: string,
  word: string
): WordCard | null {
  // 1. Bound and parse the provider response before reading any display value.
  if (raw.length > 64_000) {
    throw new Error('Word lookup response is too large');
  }

  const data = JSON.parse(raw) as Record<string, unknown> | unknown[];
  let meanings: unknown[] = [];
  if (provider === 'google') {
    const translations = (data as { data?: { translations?: unknown[] } }).data?.translations;
    meanings = Array.isArray(translations)
      ? translations.map((item) => {
          const text = (item as { translatedText?: unknown }).translatedText;
          return typeof text === 'string' ? decodeGoogleEntities(text) : text;
        })
      : [];
  } else if (kind === 'dictionary') {
    const translations = Array.isArray(data)
      ? (data[0] as { translations?: unknown[] } | undefined)?.translations
      : undefined;
    meanings = Array.isArray(translations)
      ? translations.map((item) => (item as { displayTarget?: unknown }).displayTarget)
      : [];
  } else {
    const translations = Array.isArray(data)
      ? (data[0] as { translations?: unknown[] } | undefined)?.translations
      : undefined;
    meanings = Array.isArray(translations)
      ? translations.map((item) => (item as { text?: unknown }).text)
      : [];
  }

  // 2. Keep only short, distinct plain-text meanings for the card.
  const values = [
    ...new Set(
      meanings
        .filter(
          (item): item is string =>
            typeof item === 'string' && item.trim().length > 0 && item.length <= 200
        )
        .map((item) => item.trim())
    )
  ].slice(0, 5);
  if (values.length === 0) {
    return null;
  }

  return { word, meaning: values[0], alternatives: values.slice(1) };
}

function decodeGoogleEntities(text: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  return text.replace(/&(#\d+|#x[0-9a-f]+|amp|lt|gt|quot|apos);/gi, (entity, code: string) => {
    if (code.startsWith('#')) {
      const point =
        code[1]?.toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
        ? String.fromCodePoint(point)
        : entity;
    }

    return named[code.toLowerCase()] ?? entity;
  });
}
