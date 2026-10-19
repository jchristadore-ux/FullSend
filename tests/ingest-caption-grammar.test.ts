import { describe, expect, it } from 'vitest';
import { articleForNumber, factsLines } from '../src/lib/ingest/caption';
import { factsSchema } from '../src/lib/ingest/schema';

describe('articleForNumber', () => {
  it('uses "an" for numbers spoken with an eight/eleven/eighteen sound', () => {
    for (const n of [8, 11, 18, 80, 81, 88, 89, 800, 850, 899, 8000, 11000, 18000, 80000, 8.5, '88']) {
      expect(articleForNumber(n)).toBe('an');
    }
  });
  it('uses "a" otherwise', () => {
    for (const n of [1, 7, 9, 10, 12, 17, 19, 72, 79, 90, 100, 108, 110, 118, 180, 1000, 1800, 111]) {
      expect(articleForNumber(n)).toBe('a');
    }
  });
});

describe('handicap_drop caption', () => {
  it('reads "after an 88"', () => {
    const facts = factsSchema.parse({ players: [{ display_name: 'Man of Birds' }], score: 88, index: 12.3, delta: -0.4 });
    expect(factsLines('handicap_drop', facts)[0]).toContain('after an 88');
    expect(factsLines('handicap_drop', facts)[0]).toContain('Man of Birds’s index');
  });
  it('reads "after a 92"', () => {
    const facts = factsSchema.parse({ score: 92, index: 12.3 });
    expect(factsLines('handicap_drop', facts)[0]).toContain('after a 92');
  });
});

describe('display names', () => {
  it('preserves nicknames as written', () => {
    const f = factsSchema.parse({ players: [{ display_name: '  Man  of Birds ' }, { display_name: 'McTee O’Neil-Smith' }] });
    expect(f.players.map((p) => p.display_name)).toEqual(['Man of Birds', 'McTee O’Neil-Smith']);
    expect(factsLines('round_result', { ...f, score: 80 })[0]).toContain('Man of Birds & McTee O’Neil-Smith shot 80');
  });
  it('rejects empty, too long and control characters', () => {
    expect(() => factsSchema.parse({ players: [{ display_name: '   ' }] })).toThrow();
    expect(() => factsSchema.parse({ players: [{ display_name: 'x'.repeat(81) }] })).toThrow();
    expect(() => factsSchema.parse({ players: [{ display_name: 'a\u0007b' }] })).toThrow();
  });
});
