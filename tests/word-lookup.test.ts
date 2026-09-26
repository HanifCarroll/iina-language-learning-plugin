import { expect, test } from 'bun:test';
import { languageCode, parseWordResponse, wordAt } from '../src/word-lookup';

test('Turkish word clicks keep suffixes and provider meanings stay plain text', () => {
  const sentence = 'Bu davranışı kaldıramam.';
  expect(wordAt(sentence, sentence.indexOf('kaldır') + 3)?.word).toBe('kaldıramam');
  expect(wordAt(sentence, sentence.length)).toBeNull();
  expect(languageCode('Turkish')).toBe('tr');
  expect(languageCode('English')).toBe('en');

  const google = parseWordResponse(
    'google',
    'translate',
    JSON.stringify({
      data: { translations: [{ translatedText: 'I can&#39;t handle it' }] }
    }),
    'kaldıramam'
  );
  expect(google).toEqual({ word: 'kaldıramam', meaning: "I can't handle it", alternatives: [] });

  const microsoft = parseWordResponse(
    'microsoft',
    'dictionary',
    JSON.stringify([
      {
        translations: [
          { displayTarget: 'young', posTag: 'ADJ' },
          { displayTarget: 'youthful' },
          { displayTarget: 'young' }
        ]
      }
    ]),
    'genç'
  );
  expect(microsoft).toEqual({ word: 'genç', meaning: 'young', alternatives: ['youthful'] });
  expect(
    parseWordResponse('microsoft', 'dictionary', '[{"translations":[]}]', 'kaldıramam')
  ).toBeNull();
});
