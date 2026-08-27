import {
  MAX_QUEUE_ENTRIES,
  PermanentSettlementError,
  attachRecoveredWitness,
  clearQueue,
  drainQueue,
  hasUnsettledForCard,
  listSettlements,
  markSettled,
  pendingExposure,
  pruneSettled,
  recordSpend,
  recoverableForCard,
  type SettlementEntry,
  type SpendRecord,
} from '../../src/services/cashuSettlement';

// An in-memory stand-in for the encrypted store, so persistence is real
// within a test but isolated between them.
let mockStore: Record<string, string> = {};

jest.mock('../../src/services/secureStorage', () => ({
  getSecure: jest.fn(async (k: string) => mockStore[k] ?? null),
  setSecure: jest.fn(async (k: string, v: string) => {
    mockStore[k] = v;
  }),
  removeSecure: jest.fn(async (k: string) => {
    delete mockStore[k];
  }),
}));

const CARD = '02' + 'ab'.repeat(32);
const OTHER_CARD = '03' + 'cd'.repeat(32);
const T0 = 1_700_000_000_000;

const spend = (over: Partial<SpendRecord> = {}): SpendRecord => ({
  cardPubkey: CARD,
  slot: 0,
  keysetId: '0059534ce0bfa19a',
  amount: 40,
  nonce: 'ab'.repeat(32),
  C: '02' + 'cd'.repeat(32),
  witness: 'ef'.repeat(64),
  ...over,
});

beforeEach(() => {
  mockStore = {};
});

describe('recordSpend', () => {
  it('persists before anything else can happen — the approval precondition', async () => {
    await recordSpend(spend(), T0, 'e1');
    // Read through a fresh call, i.e. what a relaunched app would see.
    const persisted = await listSettlements();
    expect(persisted).toHaveLength(1);
    expect(persisted[0].id).toBe('e1');
    expect(persisted[0].status).toBe('pending');
    expect(persisted[0].attempts).toBe(0);
  });

  it('records a witnessless burn as needs-card, not pending', async () => {
    // The card burned the slot and left the field before the signature came
    // back. The money is gone from the card; something must still owe it.
    const entry = await recordSpend(spend({witness: undefined}), T0, 'e1');
    expect(entry.status).toBe('needs-card');
  });

  it('keeps every entry distinct', async () => {
    await recordSpend(spend({slot: 0}), T0, 'e1');
    await recordSpend(spend({slot: 1, amount: 25}), T0 + 1, 'e2');
    expect((await listSettlements()).map(e => e.amount)).toEqual([40, 25]);
  });

  it('evicts settled entries, never outstanding ones, when full', async () => {
    for (let i = 0; i < MAX_QUEUE_ENTRIES; i++) {
      await recordSpend(spend({slot: i}), T0 + i, `s${i}`);
      await markSettled(`s${i}`, T0 + i);
    }
    await recordSpend(spend({slot: 999, amount: 77}), T0, 'keepme');

    const queue = await listSettlements();
    expect(queue.length).toBeLessThanOrEqual(MAX_QUEUE_ENTRIES);
    // The one entry the merchant is still owed survived the trim.
    expect(queue.find(e => e.id === 'keepme')).toBeDefined();
  });

  it('never evicts an outstanding entry even when they alone overflow', async () => {
    for (let i = 0; i < MAX_QUEUE_ENTRIES + 5; i++) {
      await recordSpend(spend({slot: i, amount: 1}), T0 + i, `p${i}`);
    }
    const queue = await listSettlements();
    expect(queue.filter(e => e.status === 'pending')).toHaveLength(
      MAX_QUEUE_ENTRIES + 5,
    );
  });
});

describe('pendingExposure', () => {
  it('totals what the merchant is actually owed', async () => {
    await recordSpend(spend({amount: 40}), T0, 'a');
    await recordSpend(spend({amount: 25, witness: undefined}), T0, 'b');
    await recordSpend(spend({amount: 10}), T0, 'c');
    await markSettled('c', T0);

    expect(await pendingExposure()).toEqual({
      total: 65, // settled 10 excluded
      count: 2,
      needsCard: 1,
      failed: 0,
    });
  });

  it('is zero on a clean till', async () => {
    expect(await pendingExposure()).toEqual({
      total: 0,
      count: 0,
      needsCard: 0,
      failed: 0,
    });
  });

  it('counts a permanently failed entry separately from what is owed', async () => {
    await recordSpend(spend({amount: 40}), T0, 'a');
    await drainQueue(async () => {
      throw new PermanentSettlementError('already spent at the mint');
    }, T0);

    const exposure = await pendingExposure();
    expect(exposure.failed).toBe(1);
    // A double-spend is not money the merchant is going to get.
    expect(exposure.total).toBe(0);
    expect(exposure.count).toBe(0);
  });
});

describe('drainQueue', () => {
  it('settles entries that the mint accepts', async () => {
    await recordSpend(spend({amount: 40}), T0, 'a');
    await recordSpend(spend({amount: 25, slot: 1}), T0, 'b');

    const swapped: string[] = [];
    const result = await drainQueue(async e => {
      swapped.push(e.id);
    }, T0);

    expect(swapped).toEqual(['a', 'b']);
    expect(result).toEqual({settled: 2, stillPending: 0, failed: 0});
    expect((await pendingExposure()).total).toBe(0);
  });

  it('keeps a transient failure outstanding and counts the attempt', async () => {
    await recordSpend(spend(), T0, 'a');
    const result = await drainQueue(async () => {
      throw new Error('network unreachable');
    }, T0 + 5);

    expect(result).toEqual({settled: 0, stillPending: 1, failed: 0});
    const [entry] = await listSettlements();
    expect(entry.status).toBe('pending');
    expect(entry.attempts).toBe(1);
    expect(entry.lastError).toMatch(/network unreachable/);
    // Still owed — a failed drain must not quietly write the money off.
    expect((await pendingExposure()).total).toBe(40);
  });

  it('retries across drains until it lands', async () => {
    await recordSpend(spend(), T0, 'a');
    let calls = 0;
    const flaky = async () => {
      calls += 1;
      if (calls < 3) {
        throw new Error('timeout');
      }
    };
    await drainQueue(flaky, T0);
    await drainQueue(flaky, T0 + 1);
    const third = await drainQueue(flaky, T0 + 2);

    expect(third.settled).toBe(1);
    expect((await listSettlements())[0].attempts).toBe(2);
  });

  it('gives up on a permanent rejection instead of retrying forever', async () => {
    await recordSpend(spend(), T0, 'a');
    const result = await drainQueue(async () => {
      throw new PermanentSettlementError('proof already spent');
    }, T0);

    expect(result).toEqual({settled: 0, stillPending: 0, failed: 1});
    expect((await listSettlements())[0].status).toBe('failed');
  });

  it('skips needs-card entries — there is nothing to submit', async () => {
    await recordSpend(spend({witness: undefined}), T0, 'a');
    const swap = jest.fn();
    const result = await drainQueue(swap, T0);

    expect(swap).not.toHaveBeenCalled();
    expect(result).toEqual({settled: 0, stillPending: 0, failed: 0});
  });

  it('does not re-submit an already settled entry', async () => {
    await recordSpend(spend(), T0, 'a');
    await drainQueue(async () => {}, T0);
    const swap = jest.fn();
    await drainQueue(swap, T0 + 1);
    expect(swap).not.toHaveBeenCalled();
  });

  it('one failure does not stop the others settling', async () => {
    await recordSpend(spend({slot: 0}), T0, 'a');
    await recordSpend(spend({slot: 1}), T0, 'b');
    await recordSpend(spend({slot: 2}), T0, 'c');

    const result = await drainQueue(async e => {
      if (e.id === 'b') {
        throw new Error('transient');
      }
    }, T0);

    expect(result).toEqual({settled: 2, stillPending: 1, failed: 0});
  });
});

describe('recovery from a lost witness', () => {
  it('re-signing moves needs-card back to pending and it then settles', async () => {
    await recordSpend(spend({witness: undefined}), T0, 'a');

    const recoverable = await recoverableForCard(CARD);
    expect(recoverable.map(e => e.id)).toEqual(['a']);

    // The card came back; SIGN_ARBITRARY produced an equally valid witness.
    await attachRecoveredWitness('a', 'aa'.repeat(64), T0 + 10);
    const entry = (await listSettlements())[0];
    expect(entry.status).toBe('pending');
    expect(entry.witness).toBe('aa'.repeat(64));

    expect((await drainQueue(async () => {}, T0 + 11)).settled).toBe(1);
  });

  it('only offers entries belonging to the card in hand', async () => {
    await recordSpend(spend({witness: undefined}), T0, 'mine');
    await recordSpend(
      spend({witness: undefined, cardPubkey: OTHER_CARD}),
      T0,
      'theirs',
    );
    expect((await recoverableForCard(CARD)).map(e => e.id)).toEqual(['mine']);
  });
});

describe('hasUnsettledForCard — the CLEAR_SPENT guard', () => {
  it('is true while the card has outstanding spends', async () => {
    await recordSpend(spend(), T0, 'a');
    // CLEAR_SPENT here would erase the slot data and turn a recoverable burn
    // into a real loss.
    expect(await hasUnsettledForCard(CARD)).toBe(true);
  });

  it('is true for a needs-card entry, which is exactly when erasing is fatal', async () => {
    await recordSpend(spend({witness: undefined}), T0, 'a');
    expect(await hasUnsettledForCard(CARD)).toBe(true);
  });

  it('goes false once everything settles', async () => {
    await recordSpend(spend(), T0, 'a');
    await drainQueue(async () => {}, T0);
    expect(await hasUnsettledForCard(CARD)).toBe(false);
  });

  it('does not confuse one card with another', async () => {
    await recordSpend(spend(), T0, 'a');
    expect(await hasUnsettledForCard(OTHER_CARD)).toBe(false);
  });
});

describe('housekeeping', () => {
  it('pruneSettled removes settled entries only', async () => {
    await recordSpend(spend({slot: 0}), T0, 'a');
    await recordSpend(spend({slot: 1}), T0, 'b');
    await markSettled('a', T0);

    expect(await pruneSettled()).toBe(1);
    expect((await listSettlements()).map(e => e.id)).toEqual(['b']);
  });

  it('clearQueue refuses while money is outstanding', async () => {
    await recordSpend(spend(), T0, 'a');
    await expect(clearQueue()).rejects.toThrow(/outstanding/);
    expect(await listSettlements()).toHaveLength(1);
  });

  it('clearQueue works once settled, and with force', async () => {
    await recordSpend(spend(), T0, 'a');
    await markSettled('a', T0);
    await clearQueue();
    expect(await listSettlements()).toEqual([]);

    await recordSpend(spend(), T0, 'b');
    await clearQueue(true);
    expect(await listSettlements()).toEqual([]);
  });
});

describe('durability', () => {
  it('survives a corrupt store rather than taking the till down', async () => {
    mockStore['@cashu_settlement_queue'] = '{ not json';
    expect(await listSettlements()).toEqual([]);
    // And the queue is usable again immediately.
    await recordSpend(spend(), T0, 'a');
    expect(await listSettlements()).toHaveLength(1);
  });

  it('survives a store holding a non-array', async () => {
    mockStore['@cashu_settlement_queue'] = '{"nope":true}';
    expect(await listSettlements()).toEqual([]);
  });

  it('a queued entry is readable after a simulated relaunch', async () => {
    await recordSpend(spend({amount: 40}), T0, 'a');
    const raw = mockStore['@cashu_settlement_queue'];

    // Nothing in memory; only what was written to disk.
    mockStore = {'@cashu_settlement_queue': raw};
    const [entry] = (await listSettlements()) as SettlementEntry[];
    expect(entry.amount).toBe(40);
    expect(entry.witness).toBe('ef'.repeat(64));
    expect((await pendingExposure()).total).toBe(40);
  });
});
