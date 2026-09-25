import { utf8Bytes } from './utf8';

export const MAX_SUBTITLE_BYTES = 8 * 1024 * 1024;
export const MAX_CUES = 50_000;
export const MAX_CUE_CHARS = 4_000;

export type Cue = {
  startMs: number;
  endMs: number;
  text: string;
  index: number;
};

function parseTimestamp(value: string): number | null {
  // 1. Validate the numeric timestamp fields.
  const parts = value.replace(',', '.').split(':');
  if (parts.length < 2 || parts.length > 3) {
    return null;
  }

  const fields = parts.map(Number);
  if (fields.some((field) => !Number.isFinite(field) || field < 0)) {
    return null;
  }

  // 2. Check minute and second bounds before converting to milliseconds.
  const [hours, minutes, seconds] = parts.length === 3 ? fields : [0, ...fields];
  if (minutes >= 60 || seconds >= 60 || !/^\d{1,2}\.\d{3}$/.test(parts.at(-1)!)) {
    return null;
  }

  return Math.round((hours * 3600 + minutes * 60 + seconds) * 1000);
}

function stripSubtitleMarkup(text: string): string {
  // Subtitle markup is data, never HTML. Handle common VTT/SRT entities only.
  const entities: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    nbsp: ' ',
    quot: '"',
    '#39': "'"
  };

  return text
    .replace(/<[^>]*>/g, '')
    .replace(/&(amp|lt|gt|nbsp|quot|#39);/g, (_, name: string) => entities[name] ?? '');
}

export function parseSubtitles(input: string, format: 'srt' | 'vtt'): Cue[] {
  // 1. Check the file limit and normalize line endings and the optional header.
  if (utf8Bytes(input) > MAX_SUBTITLE_BYTES) {
    throw new Error('Subtitle file exceeds 8 MiB');
  }

  const normalized = input.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  if (format === 'vtt' && !/^WEBVTT(?:[ \t]|$)/.test(lines[0])) {
    throw new Error('Missing WEBVTT header');
  }

  // 2. Parse timed text blocks, skipping VTT metadata.
  const blocks = normalized.split(/\n[ \t]*\n+/);
  const cues: Cue[] = [];
  for (const block of blocks) {
    const rows = block.split('\n');
    if (!rows.some((row) => row.includes('-->'))) {
      continue;
    }

    if (format === 'vtt' && /^(?:NOTE|STYLE|REGION)(?:\s|$)/.test(rows[0])) {
      continue;
    }

    const timingIndex = rows.findIndex((row) => row.includes('-->'));
    if (timingIndex > 1 || timingIndex < 0) {
      throw new Error('Malformed subtitle timing');
    }

    const match = rows[timingIndex].match(
      /^\s*(\d{1,2}(?::\d{2}){1,2}[,.]\d{3})\s*-->\s*(\d{1,2}(?::\d{2}){1,2}[,.]\d{3})(?:\s+.*)?$/
    );
    const startMs = match && parseTimestamp(match[1]);
    const endMs = match && parseTimestamp(match[2]);
    if (startMs === null || endMs === null || !match || endMs <= startMs) {
      throw new Error('Malformed subtitle timing');
    }

    const text = stripSubtitleMarkup(rows.slice(timingIndex + 1).join('\n')).trim();
    if (!text) {
      continue;
    }

    if (text.length > MAX_CUE_CHARS) {
      throw new Error('Subtitle cue exceeds 4,000 characters');
    }

    cues.push({
      startMs,
      endMs,
      text,
      index: cues.length
    });
    if (cues.length > MAX_CUES) {
      throw new Error('Subtitle file exceeds 50,000 cues');
    }
  }
  if (!cues.length) {
    throw new Error('No readable subtitle cues');
  }

  // 3. Return cues in playback order with stable sequential indexes.
  cues.sort((a, b) => a.startMs - b.startMs || a.index - b.index);

  return cues.map((cue, index) => ({ ...cue, index }));
}

export function cueAt(cues: Cue[], mediaMs: number, delayMs = 0, speed = 1): Cue | null {
  if (
    !Number.isFinite(mediaMs) ||
    !Number.isFinite(delayMs) ||
    !Number.isFinite(speed) ||
    speed <= 0
  ) {
    return null;
  }

  const subtitleMs = (mediaMs - delayMs) * speed;
  const matching = cues.filter((cue) => cue.startMs <= subtitleMs && subtitleMs < cue.endMs);

  return matching.length === 1 ? matching[0] : null;
}

export function cueForDisplay(cues: Cue[], text: string, startMs: number): Cue | null {
  if (!text || !Number.isFinite(startMs)) {
    return null;
  }

  // mpv's subtitle timestamp identifies the cue even when IINA's playhead cache lags.
  // Allow the existing 50 ms tolerance for subtitle decoder timestamp rounding.
  const matching = cues.filter((cue) => cue.text === text && Math.abs(cue.startMs - startMs) <= 50);

  return matching.length === 1 ? matching[0] : null;
}

export function contextForCue(
  source: Cue[],
  index: number,
  secondary: Cue[] = [],
  includeSecondary = true,
  timing: {
    sourceDelayMs: number;
    secondaryDelayMs: number;
    speed: number;
  } = {
    sourceDelayMs: 0,
    secondaryDelayMs: 0,
    speed: 1
  }
) {
  // 1. Validate the selected cue and playback speed.
  const current = source[index];
  if (!current || current.index !== index) {
    throw new Error('Selected cue is no longer available');
  }

  if (!Number.isFinite(timing.speed) || timing.speed <= 0) {
    throw new Error('Invalid subtitle speed');
  }

  // 2. Match secondary cues on the same adjusted playback timeline.
  const sourceStart = current.startMs / timing.speed + timing.sourceDelayMs;
  const sourceEnd = current.endMs / timing.speed + timing.sourceDelayMs;
  const neighboring = {
    before: source.slice(Math.max(0, index - 3), index),
    current,
    after: source.slice(index + 1, index + 4),
    secondary: includeSecondary
      ? secondary.filter(
          (cue) =>
            cue.startMs / timing.speed + timing.secondaryDelayMs < sourceEnd &&
            cue.endMs / timing.speed + timing.secondaryDelayMs > sourceStart
        )
      : []
  };

  // 3. Reject oversized context instead of silently truncating it.
  if (JSON.stringify(neighboring).length > 32_000) {
    throw new Error('Subtitle context exceeds limit');
  }

  return neighboring;
}
