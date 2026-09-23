import { test, expect } from 'bun:test';
import { parseSubtitles, cueAt, contextForCue } from '../src/subtitles';

test('full future timeline, timing, repeated text, and secondary overlap', () => {
  const source = parseSubtitles('\uFEFF1\r\n00:00:00,000 --> 00:00:02,000\r\nBen öyle\r\nbir insan mıyım?\r\n\r\n2\r\n00:00:04,000 --> 00:00:06,000\r\nSame\r\n\r\n3\r\n00:00:08,000 --> 00:00:10,000\r\nSame\r\n\r\n4\r\n00:00:12,000 --> 00:00:14,000\r\nEnd\r\n', 'srt');
  const secondary = parseSubtitles('WEBVTT\n\n00:00:00.500 --> 00:00:05.000\n<i>Am I that kind of person?</i>\n\n00:00:08.000 --> 00:00:09.000\nAgain', 'vtt');
  expect(source).toHaveLength(4);
  expect(source[0].text).toBe('Ben öyle\nbir insan mıyım?');
  expect(cueAt(source, 5500, 1000)?.index).toBe(1);
  expect(cueAt(source, 8500)?.index).toBe(2);
  expect(contextForCue(source, 1, secondary).after.map(c => c.text)).toEqual(['Same', 'End']);
  expect(contextForCue(source, 1, secondary).secondary.map(c => c.text)).toEqual(['Am I that kind of person?']);
  expect(contextForCue(source, 1, secondary, false).secondary).toEqual([]);
  expect(contextForCue(source, 1, secondary, true,
    { sourceDelayMs: 0, secondaryDelayMs: 7_000, speed: 1 }).secondary).toEqual([]);
});

test('malformed and ambiguous cues do not silently resolve', () => {
  expect(() => parseSubtitles('WEBVTT\n\n00:00:03.000 --> 00:00:02.000\nWrong', 'vtt')).toThrow();
  const cues = parseSubtitles('1\n00:00:00,000 --> 00:00:04,000\nA\n\n2\n00:00:02,000 --> 00:00:05,000\nB', 'srt');
  expect(cueAt(cues, 3000)).toBeNull();
  expect(cueAt(cues, 1000)?.text).toBe('A');
});

test('three cues on both sides are available before they play', () => {
  const source = parseSubtitles(Array.from({ length: 8 }, (_, index) =>
    `${index + 1}\n00:00:${String(index * 2).padStart(2, '0')},000 --> 00:00:${String(index * 2 + 1).padStart(2, '0')},000\nCue ${index}`
  ).join('\n\n'), 'srt');
  expect(contextForCue(source, 3).before.map(c => c.index)).toEqual([0, 1, 2]);
  expect(contextForCue(source, 3).after.map(c => c.index)).toEqual([4, 5, 6]);
  expect(contextForCue(source, 0).before).toEqual([]);
});
