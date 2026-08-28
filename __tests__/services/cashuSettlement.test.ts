import {
  CORRUPT_QUEUE_KEY,
  MAX_QUEUE_ENTRIES,
  PermanentSettlementError,
  QueueUnavailableError,
  SettlementPersistenceError,
  __resetDrainState,
  attachRecoveredWitness,
  clearQueue,
  drainQueue,
  hasUnsettledForCard,
  isOutstanding,
  listSettlements,
  markFailed,
  markSettled,
  pendingExposure,
  pruneSettled,
  recordSpend,
  recoverableForCard,
  recoveryMessage,
  recoveryMessageHex,
  toCashuProof,
  type SettlementEntry,
  type SpendRecord,
} from '../../src/services/cashuSettlement';

// An in-memory stand-in for the encrypted store, so persistence is real
// within a test but isolated between them.
let mockStore: Record<string, string> = {};
/** Set to reject to simulate a Keychain that cannot be read or written. */
let mockReadFails: Error | null = null;
let mockWriteFails: Error | null = null;
/**
 * Milliseconds each store operation takes. Zero by default; a test that needs
 * two callers to genuinely interleave across the bridge raises it.
 */
let mockLatency = 0;

const mockSettle = () =>
  mockLatency > 0
    ? new Promise(resolve => setTimeout(resolve, mockLatency))
    : Promise.resolve();

jest.mock('../../src/services/secureStorage', () => ({
  getSecureStrict: jest.fn(async (k: string) => {
    await mockSettle();
    if (mockReadFails) {
      throw mockReadFails;
    }
    return mockStore[k] ?? null;
  }),
  getSecure: jest.fn(async (k: string) => {
    await mockSettle();
    return mockReadFails ? null : mockStore[k] ?? null;
  }),
  setSecure: jest.fn(async (k: string, v: string) => {
    await mockSettle();
    if (mockWriteFails) {
      throw mockWriteFails;
    }
    mockStore[k] = v;
  }),
  removeSecure: jest.fn(async (k: string) => {
    await mockSettle();
    delete mockStore[k];
  }),
}));

const CARD = '02' + 'ab'.repeat(32);
const OTHER_CARD = '03' + 'cd'.repeat(32);
const T0 = 1_700_000_000_000;

const SECRET = JSON.stringify([
  'P2PK',
  {
    nonce: 'ab'.repeat(32),
    data: '02' + 'ef'.repeat(32),
    tags: [['sigflag', 'SIG_INPUTS']],
  },
]);

const spend = (over: Partial<SpendRecord> = {}): SpendRecord => ({
  cardPubkey: CARD,
  slot: 0,
  keysetId: '0059534ce0bfa19a',
  amount: 40,
  nonce: 'ab'.repeat(32),
  secret: SECRET,
  C: '02' + 'cd'.repeat(32),
  witness: 'ef'.repeat(64),
  ...over,
});

const QUEUE_KEY = '@cashu_settlement_queue';

beforeEach(() => {
  mockStore = {};
  mockReadFails = null;
  mockWriteFails = null;
  mockLatency = 0;
  __resetDrainState();
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

  // Two taps in the same millisecond under a Date.now() id used to write two
  // entries sharing an id: update() patches only the first, so the duplicate
  // stayed pending forever and drainQueue submitted the same proof twice.
  it('refuses a duplicate id instead of writing an unpatchable twin', async () => {
    await recordSpend(spend({slot: 0}), T0, 'dupe');
    await expect(recordSpend(spend({slot: 1}), T0, 'dupe')).rejects.toThrow(
      /already recorded/,
    );
    expect(await listSettlements()).toHaveLength(1);
  });

  // Without the secret there is no proof to submit and no message to re-sign.
  it('refuses a record with no proof secret — it would be unsettleable', async () => {
    await expect(recordSpend(spend({secret: ''}), T0, 'e1')).rejects.toThrow(
      /missing the proof secret/,
    );
    expect(await listSettlements()).toEqual([]);
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

  // Regression: `settled.slice(-room)` with room === 0 is `slice(0)`, i.e. the
  // whole array — so in the exact case the cap exists for, eviction dropped
  // nothing and the blob grew without bound in the Keychain.
  it('drops settled entries even when outstanding ones alone fill the queue', async () => {
    for (let i = 0; i < MAX_QUEUE_ENTRIES + 5; i++) {
      await recordSpend(spend({slot: i, amount: 1}), T0 + i, `p${i}`);
    }
    await markSettled('p0', T0);
    await markSettled('p1', T0);
    await markSettled('p2', T0);
    expect(await listSettlements()).toHaveLength(MAX_QUEUE_ENTRIES + 5);

    await recordSpend(spend({slot: 999, amount: 77}), T0, 'newest');

    const queue = await listSettlements();
    expect(queue.filter(e => e.status === 'settled')).toEqual([]);
    expect(queue.find(e => e.id === 'newest')).toBeDefined();
    // The three settled entries went; every outstanding one stayed.
    expect(queue.filter(isOutstanding)).toHaveLength(MAX_QUEUE_ENTRIES + 3);
  });
});

describe('reconstructing the proof from disk', () => {
  it('rebuilds a full mint-ready proof from a persisted entry alone', async () => {
    await recordSpend(spend({amount: 40}), T0, 'a');

    // Nothing in memory; only what was written to the store, as after a kill.
    const [entry] = await listSettlements();
    const proof = toCashuProof(entry);

    expect(proof).toEqual({
      id: '0059534ce0bfa19a',
      amount: 40,
      secret: SECRET,
      C: '02' + 'cd'.repeat(32),
      witness: JSON.stringify({signatures: ['ef'.repeat(64)]}),
    });
    // Every field a swap needs is present and non-empty.
    expect(Object.values(proof).every(v => v !== '' && v !== undefined)).toBe(
      true,
    );
  });

  it('refuses to build a proof with no witness rather than sending a broken one', async () => {
    await recordSpend(spend({witness: undefined}), T0, 'a');
    const [entry] = await listSettlements();
    expect(() => toCashuProof(entry)).toThrow(/no witness/);
  });

  // The card cannot return the secret, only the nonce — so the recovery
  // message has to come from the persisted secret or it cannot be produced.
  it('derives the re-sign message as sha256(utf8(secret)) from the entry', async () => {
    await recordSpend(spend({witness: undefined}), T0, 'a');
    const [entry] = await listSettlements();

    const message = recoveryMessage(entry);
    expect(message).toHaveLength(32);
    expect(message.every(b => b >= 0 && b <= 255)).toBe(true);
    // Same input, same message — the card can be re-tapped any number of times.
    expect(recoveryMessage(entry)).toEqual(message);
    expect(recoveryMessageHex(entry)).toHaveLength(64);
    // It is a function of the secret, not the nonce.
    expect(recoveryMessageHex({secret: SECRET})).toBe(
      recoveryMessageHex(entry),
    );
    expect(recoveryMessageHex({secret: SECRET + ' '})).not.toBe(
      recoveryMessageHex(entry),
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
    expect(result).toEqual({settled: 2, stillPending: 0, failed: 0, lost: 0});
    expect((await pendingExposure()).total).toBe(0);
  });

  it('keeps a transient failure outstanding and counts the attempt', async () => {
    await recordSpend(spend(), T0, 'a');
    const result = await drainQueue(async () => {
      throw new Error('network unreachable');
    }, T0 + 5);

    expect(result).toEqual({settled: 0, stillPending: 1, failed: 0, lost: 0});
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

    expect(result).toEqual({settled: 0, stillPending: 0, failed: 1, lost: 0});
    expect((await listSettlements())[0].status).toBe('failed');
  });

  it('skips needs-card entries — there is nothing to submit', async () => {
    await recordSpend(spend({witness: undefined}), T0, 'a');
    const swap = jest.fn();
    const result = await drainQueue(swap, T0);

    expect(swap).not.toHaveBeenCalled();
    expect(result).toEqual({settled: 0, stillPending: 0, failed: 0, lost: 0});
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

    expect(result).toEqual({settled: 2, stillPending: 1, failed: 0, lost: 0});
  });

  // Two triggers — app foreground and a connectivity change — used to both read
  // the same 'pending' entry and both submit it. The loser took a double-spend
  // rejection and markFailed overwrote the winner's 'settled'.
  it('refuses to run twice at once, so a proof is never submitted twice', async () => {
    await recordSpend(spend(), T0, 'a');

    const second = jest.fn(async () => {});
    let nested: Awaited<ReturnType<typeof drainQueue>> | undefined;

    const outer = await drainQueue(async () => {
      nested = await drainQueue(second, T0);
    }, T0);

    expect(second).not.toHaveBeenCalled();
    expect(nested).toEqual({settled: 0, stillPending: 0, failed: 0, lost: 0});
    expect(outer.settled).toBe(1);
    expect((await listSettlements())[0].status).toBe('settled');
  });

  // markSettled returns null when the entry has vanished. Counting that as a
  // settlement reports a persistence that did not happen.
  it('counts an unattributable mint success as lost, not settled', async () => {
    await recordSpend(spend(), T0, 'a');

    const result = await drainQueue(async () => {
      // The entry is pruned out from under the drain, mid-swap.
      mockStore[QUEUE_KEY] = JSON.stringify([]);
    }, T0);

    expect(result).toEqual({settled: 0, stillPending: 0, failed: 0, lost: 1});
  });

  it('counts an unattributable failure as lost too', async () => {
    await recordSpend(spend(), T0, 'a');

    const result = await drainQueue(async () => {
      mockStore[QUEUE_KEY] = JSON.stringify([]);
      throw new Error('network unreachable');
    }, T0);

    expect(result).toEqual({settled: 0, stillPending: 0, failed: 0, lost: 1});
  });

  // The money is at the mint the instant swap resolves. A write failure after
  // that is a persistence problem, never a settlement failure — marking it
  // 'failed' would write off money the merchant actually received, and leaving
  // it 'pending' would re-submit a proof the mint has already consumed.
  it('does not leave a mint-accepted proof re-submittable when the write fails', async () => {
    await recordSpend(spend(), T0, 'a');

    const swap = jest.fn(async () => {
      mockWriteFails = new Error('keychain write denied');
    });

    await expect(drainQueue(swap, T0)).rejects.toBeInstanceOf(
      SettlementPersistenceError,
    );
    expect(swap).toHaveBeenCalledTimes(1);

    // On disk the entry is still 'pending' — the write never landed — but the
    // next drain must not hand the same proof to the mint again.
    mockWriteFails = null;
    const stored = await listSettlements();
    expect(stored[0].status).toBe('pending');
    expect(stored[0].lastError).toBeUndefined();

    const second = await drainQueue(swap, T0 + 1);
    expect(swap).toHaveBeenCalledTimes(1); // not re-submitted
    expect(second).toEqual({settled: 1, stillPending: 0, failed: 0, lost: 0});
    expect((await listSettlements())[0].status).toBe('settled');
  });
});

describe('concurrent mutation', () => {
  it('does not let a background drain clobber a tap recorded mid-flight', async () => {
    await recordSpend(spend({slot: 0}), T0, 'a');
    // Force the two callers to genuinely interleave across the bridge.
    mockLatency = 2;

    await Promise.all([
      recordSpend(spend({slot: 1, amount: 25}), T0 + 1, 'b'),
      markSettled('a', T0 + 1),
    ]);

    mockLatency = 0;
    const queue = await listSettlements();
    // Neither write was lost: the tap survived and the settle stuck.
    expect(queue.map(e => e.id).sort()).toEqual(['a', 'b']);
    expect(queue.find(e => e.id === 'a')?.status).toBe('settled');
    expect(queue.find(e => e.id === 'b')?.status).toBe('pending');
  });

  it('a rejected mutation does not poison the ones queued behind it', async () => {
    await recordSpend(spend({slot: 0}), T0, 'a');
    mockLatency = 2;

    const results = await Promise.allSettled([
      recordSpend(spend({slot: 1}), T0, 'a'), // duplicate id — rejects
      recordSpend(spend({slot: 2}), T0, 'c'),
    ]);

    mockLatency = 0;
    expect(results[0].status).toBe('rejected');
    expect(results[1].status).toBe('fulfilled');
    expect((await listSettlements()).map(e => e.id)).toEqual(['a', 'c']);
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

  // A recovery UI can re-tap a card whose entry has already settled. Flipping
  // it back to 'pending' would re-submit a proof the mint has consumed.
  it('will not resurrect a settled entry into the drain loop', async () => {
    await recordSpend(spend(), T0, 'a');
    await drainQueue(async () => {}, T0);

    await attachRecoveredWitness('a', 'aa'.repeat(64), T0 + 10);

    const entry = (await listSettlements())[0];
    expect(entry.status).toBe('settled');
    expect(entry.witness).toBe('ef'.repeat(64));

    const swap = jest.fn();
    await drainQueue(swap, T0 + 11);
    expect(swap).not.toHaveBeenCalled();
  });

  it('will not resurrect a permanently failed entry either', async () => {
    await recordSpend(spend(), T0, 'a');
    await markFailed('a', 'already spent at the mint', T0);

    await attachRecoveredWitness('a', 'aa'.repeat(64), T0 + 10);
    expect((await listSettlements())[0].status).toBe('failed');
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

  it('clearQueue works once nothing is outstanding', async () => {
    await recordSpend(spend(), T0, 'a');
    await markSettled('a', T0);
    await clearQueue();
    expect(await listSettlements()).toEqual([]);

    // A permanently failed entry is not outstanding either.
    await recordSpend(spend(), T0, 'b');
    await markFailed('b', 'already spent at the mint', T0);
    await clearQueue();
    expect(await listSettlements()).toEqual([]);
  });
});

describe('durability', () => {
  it('survives a corrupt store rather than taking the till down', async () => {
    mockStore[QUEUE_KEY] = '{ not json';
    expect(await listSettlements()).toEqual([]);
    // And the queue is usable again immediately.
    await recordSpend(spend(), T0, 'a');
    expect(await listSettlements()).toHaveLength(1);
  });

  it('survives a store holding a non-array', async () => {
    mockStore[QUEUE_KEY] = '{"nope":true}';
    expect(await listSettlements()).toEqual([]);
  });

  // Losing the file loses the record of money already spent, so the raw bytes
  // are copied aside before the next write overwrites them.
  it('quarantines corrupt bytes before anything overwrites them', async () => {
    mockStore[QUEUE_KEY] = '{ not json';

    await listSettlements();
    expect(mockStore[CORRUPT_QUEUE_KEY]).toBe('{ not json');

    await recordSpend(spend(), T0, 'a');
    // The queue moved on; the forensic copy is untouched.
    expect(mockStore[CORRUPT_QUEUE_KEY]).toBe('{ not json');
    expect(mockStore[QUEUE_KEY]).not.toBe('{ not json');
  });

  // A corrupt queue is a queue whose outstanding entries are unknown. The gate
  // the whole design rests on must stay shut.
  it('keeps the CLEAR_SPENT gate shut on a corrupt queue', async () => {
    mockStore[QUEUE_KEY] = '{ not json';
    expect(await hasUnsettledForCard(CARD)).toBe(true);
  });

  it('a queued entry is readable after a simulated relaunch', async () => {
    await recordSpend(spend({amount: 40}), T0, 'a');
    const raw = mockStore[QUEUE_KEY];

    // Nothing in memory; only what was written to disk.
    mockStore = {[QUEUE_KEY]: raw};
    const [entry] = (await listSettlements()) as SettlementEntry[];
    expect(entry.amount).toBe(40);
    expect(entry.witness).toBe('ef'.repeat(64));
    expect(entry.secret).toBe(SECRET);
    expect((await pendingExposure()).total).toBe(40);
  });
});

describe('an unreadable store is not an empty one', () => {
  it('recordSpend refuses to write over a queue it could not read', async () => {
    await recordSpend(spend({slot: 0}), T0, 'existing');
    const before = mockStore[QUEUE_KEY];

    mockReadFails = new Error('keychain locked');
    await expect(
      recordSpend(spend({slot: 1}), T0, 'new'),
    ).rejects.toBeInstanceOf(QueueUnavailableError);

    // The outstanding entry is untouched — no write happened at all.
    mockReadFails = null;
    expect(mockStore[QUEUE_KEY]).toBe(before);
    expect((await listSettlements()).map(e => e.id)).toEqual(['existing']);
  });

  it('hasUnsettledForCard fails closed so CLEAR_SPENT stays blocked', async () => {
    mockReadFails = new Error('keychain locked');
    expect(await hasUnsettledForCard(CARD)).toBe(true);
  });

  it('pendingExposure refuses to report a clean till it cannot vouch for', async () => {
    await recordSpend(spend({amount: 40}), T0, 'a');
    mockReadFails = new Error('keychain locked');

    await expect(pendingExposure()).rejects.toBeInstanceOf(
      QueueUnavailableError,
    );
  });

  it('listSettlements surfaces the failure instead of an empty list', async () => {
    mockReadFails = new Error('keychain locked');
    await expect(listSettlements()).rejects.toThrow(/unreadable/);
  });

  it('drainQueue submits nothing when the queue cannot be read', async () => {
    const swap = jest.fn();
    mockReadFails = new Error('keychain locked');

    await expect(drainQueue(swap, T0)).rejects.toBeInstanceOf(
      QueueUnavailableError,
    );
    expect(swap).not.toHaveBeenCalled();
  });

  it('a failed read does not wedge the queue for later callers', async () => {
    await recordSpend(spend({slot: 0}), T0, 'a');
    mockReadFails = new Error('keychain locked');
    await expect(listSettlements()).rejects.toBeInstanceOf(
      QueueUnavailableError,
    );

    mockReadFails = null;
    await recordSpend(spend({slot: 1}), T0, 'b');
    expect((await listSettlements()).map(e => e.id)).toEqual(['a', 'b']);
  });
});
