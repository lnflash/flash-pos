/**
 * The offline refusal log (ENG-701): counts that never go down, the last
 * 200 entries, nothing but the bill and the card's piece sizes.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  REFUSAL_LOG_CAP,
  REFUSAL_LOG_KEY,
  getRefusalCounts,
  getRefusalLog,
  recordRefusal,
} from '../../src/services/refusalLog';

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe('refusalLog', () => {
  it('starts empty', async () => {
    await expect(getRefusalCounts()).resolves.toEqual({
      change_needs_mint: 0,
      online_only: 0,
    });
    await expect(getRefusalLog()).resolves.toEqual([]);
  });

  it('counts each kind and logs each refusal, newest first', async () => {
    await recordRefusal('change_needs_mint', 3, [8], 1000);
    await recordRefusal('online_only', 16, [16, 4], 2000);
    await recordRefusal('change_needs_mint', 3, [8], 3000);

    await expect(getRefusalCounts()).resolves.toEqual({
      change_needs_mint: 2,
      online_only: 1,
    });
    await expect(getRefusalLog()).resolves.toEqual([
      {kind: 'change_needs_mint', amountSat: 3, cardPieces: [8], at: 3000},
      {kind: 'online_only', amountSat: 16, cardPieces: [16, 4], at: 2000},
      {kind: 'change_needs_mint', amountSat: 3, cardPieces: [8], at: 1000},
    ]);
  });

  it(`keeps the last ${REFUSAL_LOG_CAP} entries while the counts keep going`, async () => {
    for (let i = 0; i < REFUSAL_LOG_CAP + 25; i++) {
      await recordRefusal('online_only', i + 1, [1], i);
    }
    const log = await getRefusalLog();
    expect(log).toHaveLength(REFUSAL_LOG_CAP);
    expect(log[0].amountSat).toBe(REFUSAL_LOG_CAP + 25);
    expect(log[log.length - 1].amountSat).toBe(26);
    await expect(getRefusalCounts()).resolves.toEqual({
      change_needs_mint: 0,
      online_only: REFUSAL_LOG_CAP + 25,
    });
  });

  it('loses nothing when refusals are recorded together', async () => {
    await Promise.all(
      Array.from({length: 30}, (_, i) =>
        recordRefusal(
          i % 2 ? 'online_only' : 'change_needs_mint',
          i + 1,
          [i],
          i,
        ),
      ),
    );
    await expect(getRefusalCounts()).resolves.toEqual({
      change_needs_mint: 15,
      online_only: 15,
    });
    const log = await getRefusalLog();
    expect(log.map(e => e.amountSat).sort((a, b) => a - b)).toEqual(
      Array.from({length: 30}, (_, i) => i + 1),
    );
  });

  it('resets a stored value that does not parse, rather than throwing', async () => {
    for (const bad of ['{not json', '[]', '{"v":2}', 'null', '{"v":1}']) {
      await AsyncStorage.setItem(REFUSAL_LOG_KEY, bad);
      await expect(getRefusalLog()).resolves.toEqual([]);
      await recordRefusal('online_only', 5, [8], 1);
      await expect(getRefusalCounts()).resolves.toEqual({
        change_needs_mint: 0,
        online_only: 1,
      });
      await AsyncStorage.clear();
    }
  });

  it('keeps only the kind, the bill, the piece sizes and the time', async () => {
    await recordRefusal('change_needs_mint', 3, [8, 4], 1000);
    const stored = JSON.parse(
      (await AsyncStorage.getItem(REFUSAL_LOG_KEY)) as string,
    );
    expect(Object.keys(stored.entries[0]).sort()).toEqual(
      ['amountSat', 'at', 'cardPieces', 'kind'].sort(),
    );
  });

  it('a write that fails rejects without blocking the next one', async () => {
    (AsyncStorage.setItem as jest.Mock).mockImplementationOnce(async () => {
      throw new Error('disk full');
    });
    await expect(recordRefusal('online_only', 1, [1], 1)).rejects.toThrow(
      'disk full',
    );
    await recordRefusal('online_only', 2, [1], 2);
    await expect(getRefusalCounts()).resolves.toEqual({
      change_needs_mint: 0,
      online_only: 1,
    });
  });
});
