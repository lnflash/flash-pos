import {
  CORRUPT_QUEUE_KEY,
  LEGACY_MINT_URL,
  LEGACY_UNIT,
  MAX_QUEUE_ENTRIES,
  PermanentSettlementError,
  ProofAlreadySpentError,
  QUEUE_SCHEMA_VERSION,
  QueueUnavailableError,
  SettlementPersistenceError,
  TransportSettlementError,
  UNKNOWN_EXPOSURE_KEY,
  __resetDrainState,
  __setPersistDelay,
  acknowledgeFailed,
  acknowledgeUnknownExposure,
  attachRecoveredWitness,
  clearQueue,
  drainQueue,
  hasUnsettledForCard,
  isOutstanding,
  listSettlements,
  markFailed,
  markSettled,
  pendingExposure,
  pruneFailed,
  pruneSettled,
  quarantineKeyFor,
  recordSpend,
  recoverableForCard,
  recoveryMessage,
  recoveryMessageHex,
  settlementId,
  toCashuProof,
  type DrainResult,
  type SettlementEntry,
  type SpendRecord,
} from '../../src/services/cashuSettlement';

// An in-memory stand-in for the encrypted store, so persistence is real
// within a test but isolated between them.
let mockStore: Record<string, string> = {};
/** Set to reject to simulate a Keychain that cannot be read or written. */
let mockReadFails: Error | null = null;
let mockWriteFails: Error | null = null;
/** Narrows `mockWriteFails` to a single key; null means every key fails. */
let mockWriteFailsOnlyFor: string | null = null;
/**
 * Number of writes still to be refused, for a store that recovers on its own.
 * Lets one entry's settle write fail without taking the next entry's with it.
 */
let mockWriteFailBudget = 0;
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
    if (mockWriteFailBudget > 0) {
      mockWriteFailBudget -= 1;
      throw new Error('keychain write denied');
    }
    if (
      mockWriteFails &&
      (!mockWriteFailsOnlyFor || mockWriteFailsOnlyFor === k)
    ) {
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
const MINT = 'https://mint.flashapp.me';
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
  mintUrl: MINT,
  unit: 'sat',
  amount: 40,
  nonce: 'ab'.repeat(32),
  secret: SECRET,
  C: '02' + 'cd'.repeat(32),
  witness: 'ef'.repeat(64),
  ...over,
});

/** Record a burn; the id is derived, so tests never invent one. */
const record = (over: Partial<SpendRecord> = {}, now = T0) =>
  recordSpend(spend(over), now);

/** The id `record(over)` will produce, for tests that need it up front. */
const idOf = (over: Partial<SpendRecord> = {}) => settlementId(spend(over));

const QUEUE_KEY = '@cashu_settlement_queue';

/** The entries inside the stored envelope. */
const stored = (): SettlementEntry[] =>
  JSON.parse(mockStore[QUEUE_KEY]).entries;

/** An entry in the `v0` shape: exactly what the previous release wrote. */
const asV0 = (entry: SettlementEntry): Record<string, unknown> => {
  const v0: Record<string, unknown> = {...entry};
  delete v0.mintUrl;
  delete v0.unit;
  return v0;
};

/** Put raw elements on disk inside a current-version envelope. */
const storeRaw = (entries: unknown[], v: number = QUEUE_SCHEMA_VERSION) => {
  mockStore[QUEUE_KEY] = JSON.stringify({v, entries});
};

/** A `DrainResult` with only the interesting fields spelled out. */
const drained = (over: Partial<DrainResult> = {}): DrainResult => ({
  settled: 0,
  stillPending: 0,
  failed: 0,
  lost: 0,
  persistenceErrors: [],
  skipped: false,
  ...over,
});

/** Every backoff the persist loop asked for, in order. */
let persistDelays: number[] = [];

/**
 * Everything the process forgets when the app is killed and relaunched: the
 * in-memory mint-confirmation set and the drain lock. The store survives.
 *
 * Also re-installs the delay seam, so the backoff is driven rather than waited
 * through in real time.
 */
const relaunch = () => {
  __resetDrainState();
  __setPersistDelay(async ms => {
    persistDelays.push(ms);
  });
};

/**
 * The on-disk state of a process killed mid-drain: the claim write has landed,
 * the swap has not returned. Captured from the store rather than hand-written,
 * so it is exactly what the module wrote.
 */
const killedMidSubmission = async (over: Partial<SpendRecord> = {}) => {
  await record(over);
  let snapshot = '';
  await drainQueue(async () => {
    snapshot = mockStore[QUEUE_KEY];
    throw new Error('killed');
  }, T0);
  mockStore[QUEUE_KEY] = snapshot;
  relaunch();
};

beforeEach(() => {
  mockStore = {};
  mockReadFails = null;
  mockWriteFails = null;
  mockWriteFailsOnlyFor = null;
  mockWriteFailBudget = 0;
  mockLatency = 0;
  persistDelays = [];
  relaunch();
});

describe('recordSpend', () => {
  it('persists before anything else can happen — the approval precondition', async () => {
    await record();
    // Read through a fresh call, i.e. what a relaunched app would see.
    const persisted = await listSettlements();
    expect(persisted).toHaveLength(1);
    expect(persisted[0].id).toBe(idOf());
    expect(persisted[0].status).toBe('pending');
    expect(persisted[0].attempts).toBe(0);
  });

  it('records a witnessless burn as needs-card, not pending', async () => {
    // The card burned the slot and left the field before the signature came
    // back. The money is gone from the card; something must still owe it.
    const entry = await record({witness: undefined});
    expect(entry.status).toBe('needs-card');
  });

  it('keeps every entry distinct', async () => {
    await record({slot: 0});
    await record({slot: 1, amount: 25}, T0 + 1);
    expect((await listSettlements()).map(e => e.amount)).toEqual([40, 25]);
  });

  // The id is `<cardPubkey>:<slot>:<nonce>` — unique per burn by construction,
  // so nothing upstream has to invent one and nothing can collide.
  it('derives the id from the burn itself', async () => {
    const entry = await record({slot: 3});
    expect(entry.id).toBe(`${CARD}:3:${'ab'.repeat(32)}`);
    expect(entry.id).not.toBe(idOf({slot: 4}));
    expect(idOf({cardPubkey: OTHER_CARD})).not.toBe(idOf());
  });

  // A throw from recordSpend means "do not approve the payment". The slot is
  // already burned by the time this is called, so a retry — a generic wrapper,
  // a double-tap, a re-render — must never turn into a decline.
  it('is idempotent for the same burn instead of declining it', async () => {
    const first = await record({amount: 40});
    const again = await recordSpend(spend({amount: 40}), T0 + 500);

    expect(again).toEqual(first);
    // The original createdAt survived: this is the stored entry, not a rewrite.
    expect(again.createdAt).toBe(T0);
    expect(await listSettlements()).toHaveLength(1);
  });

  // update() patches only the first match, so a twin would stay pending forever
  // and drainQueue would submit the same proof twice.
  it('never writes an unpatchable twin', async () => {
    await record();
    await record();
    await markSettled(idOf(), T0 + 1);
    expect((await listSettlements()).map(e => e.status)).toEqual(['settled']);
  });

  // Without the secret there is no proof to submit and no message to re-sign.
  it('refuses a record with no proof secret — it would be unsettleable', async () => {
    await expect(record({secret: ''})).rejects.toThrow(
      /missing the proof secret/,
    );
    expect(await listSettlements()).toEqual([]);
  });

  // The configured mint can move while entries are queued; "whatever is
  // configured at drain time" would submit this proof to a mint that never
  // issued it.
  it('refuses a record with no mint url', async () => {
    await expect(record({mintUrl: ''})).rejects.toThrow(/missing the mint url/);
    expect(await listSettlements()).toEqual([]);
  });

  it('refuses a record with no unit — the amount would not be totalable', async () => {
    await expect(record({unit: ''})).rejects.toThrow(/missing the keyset unit/);
    expect(await listSettlements()).toEqual([]);
  });

  it('persists the mint and unit so a drain does not have to guess', async () => {
    await record({mintUrl: 'https://other.mint.example', unit: 'usd'});
    const [entry] = await listSettlements();
    expect(entry.mintUrl).toBe('https://other.mint.example');
    expect(entry.unit).toBe('usd');
  });

  it('evicts settled entries, never outstanding ones, when full', async () => {
    for (let i = 0; i < MAX_QUEUE_ENTRIES; i++) {
      await record({slot: i}, T0 + i);
      await markSettled(idOf({slot: i}), T0 + i);
    }
    await record({slot: 999, amount: 77});

    const queue = await listSettlements();
    expect(queue.length).toBeLessThanOrEqual(MAX_QUEUE_ENTRIES);
    // The one entry the merchant is still owed survived the trim.
    expect(queue.find(e => e.id === idOf({slot: 999}))).toBeDefined();
  });

  it('never evicts an outstanding entry even when they alone overflow', async () => {
    for (let i = 0; i < MAX_QUEUE_ENTRIES + 5; i++) {
      await record({slot: i, amount: 1}, T0 + i);
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
      await record({slot: i, amount: 1}, T0 + i);
    }
    await markSettled(idOf({slot: 0, amount: 1}), T0);
    await markSettled(idOf({slot: 1, amount: 1}), T0);
    await markSettled(idOf({slot: 2, amount: 1}), T0);
    expect(await listSettlements()).toHaveLength(MAX_QUEUE_ENTRIES + 5);

    await record({slot: 999, amount: 77});

    const queue = await listSettlements();
    expect(queue.filter(e => e.status === 'settled')).toEqual([]);
    expect(
      queue.find(e => e.id === idOf({slot: 999, amount: 77})),
    ).toBeDefined();
    // The three settled entries went; every outstanding one stayed.
    expect(queue.filter(isOutstanding)).toHaveLength(MAX_QUEUE_ENTRIES + 3);
  });

  // Eviction used to rebuild the queue as [settled..., outstanding...], so the
  // first eviction silently reordered it and neither listSettlements nor the
  // drain loop was chronological afterwards.
  it('keeps the queue chronological after an eviction', async () => {
    for (let i = 0; i < MAX_QUEUE_ENTRIES; i++) {
      await record({slot: i, amount: 1}, T0 + i);
    }
    // One old settled entry in the middle is the only thing evictable.
    await markSettled(idOf({slot: 100, amount: 1}), T0);
    await record({slot: 999, amount: 77}, T0 + 1000);

    const times = (await listSettlements()).map(e => e.createdAt);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });
});

describe('reconstructing the proof from disk', () => {
  it('rebuilds a full mint-ready proof from a persisted entry alone', async () => {
    await record({amount: 40});

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
    // And the entry still knows where to send it.
    expect(entry.mintUrl).toBe(MINT);
  });

  it('refuses to build a proof with no witness rather than sending a broken one', async () => {
    await record({witness: undefined});
    const [entry] = await listSettlements();
    expect(() => toCashuProof(entry)).toThrow(/no witness/);
  });

  // The card cannot return the secret, only the nonce — so the recovery
  // message has to come from the persisted secret or it cannot be produced.
  it('derives the re-sign message as sha256(utf8(secret)) from the entry', async () => {
    await record({witness: undefined});
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
    await record({slot: 0, amount: 40});
    await record({slot: 1, amount: 25, witness: undefined});
    await record({slot: 2, amount: 10});
    await markSettled(idOf({slot: 2}), T0);

    expect(await pendingExposure()).toEqual({
      totals: {sat: {amount: 65, count: 2}}, // settled 10 excluded
      count: 2,
      needsCard: 1,
      failed: 0,
    });
  });

  it('is zero on a clean till', async () => {
    expect(await pendingExposure()).toEqual({
      totals: {},
      count: 0,
      needsCard: 0,
      failed: 0,
    });
  });

  // Nothing constrains the queue to one keyset. Summing across units produced a
  // number that is not money in any currency, and that is the number the whole
  // exposure report exists to show the merchant honestly.
  it('never sums across units', async () => {
    await record({slot: 0, amount: 40, unit: 'sat'});
    await record({slot: 1, amount: 40, unit: 'usd'});

    const exposure = await pendingExposure();
    expect(exposure.totals).toEqual({
      sat: {amount: 40, count: 1},
      usd: {amount: 40, count: 1},
    });
    expect(exposure.count).toBe(2);
  });

  it('counts a permanently failed entry separately from what is owed', async () => {
    await record({amount: 40});
    await drainQueue(async () => {
      throw new PermanentSettlementError('malformed proof');
    }, T0);

    const exposure = await pendingExposure();
    expect(exposure.failed).toBe(1);
    // A proof the mint will never take is not money the merchant is going to get.
    expect(exposure.totals).toEqual({});
    expect(exposure.count).toBe(0);
  });
});

describe('drainQueue', () => {
  it('settles entries that the mint accepts', async () => {
    await record({slot: 0, amount: 40});
    await record({slot: 1, amount: 25});

    const swapped: string[] = [];
    const result = await drainQueue(async e => {
      swapped.push(e.id);
    }, T0);

    expect(swapped).toEqual([idOf({slot: 0}), idOf({slot: 1})]);
    expect(result).toEqual(drained({settled: 2}));
    expect((await pendingExposure()).totals).toEqual({});
  });

  // The mint that issued a proof is the only one that can settle it, and the
  // configured one can have changed since the burn.
  it('hands the swap the mint the proof was issued by', async () => {
    await record({slot: 0, mintUrl: 'https://old.mint.example'});
    const seen: string[] = [];
    await drainQueue(async e => {
      seen.push(e.mintUrl);
    }, T0);
    expect(seen).toEqual(['https://old.mint.example']);
  });

  it('keeps a transient failure outstanding and counts the attempt', async () => {
    await record();
    const result = await drainQueue(async () => {
      throw new Error('network unreachable');
    }, T0 + 5);

    expect(result).toEqual(drained({stillPending: 1}));
    const [entry] = await listSettlements();
    // 'submitting', not 'pending': the claim write landed before the call, and
    // a plain rejection cannot tell a request the mint never saw from one it
    // processed before the response timed out.
    expect(entry.status).toBe('submitting');
    expect(entry.attempts).toBe(1);
    expect(entry.lastError).toMatch(/network unreachable/);
    // Still owed — a failed drain must not quietly write the money off.
    expect((await pendingExposure()).totals.sat.amount).toBe(40);
  });

  it('retries across drains until it lands', async () => {
    await record();
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
    await record();
    const result = await drainQueue(async () => {
      throw new PermanentSettlementError('malformed proof');
    }, T0);

    expect(result).toEqual(drained({failed: 1}));
    expect((await listSettlements())[0].status).toBe('failed');
  });

  it('skips needs-card entries — there is nothing to submit', async () => {
    await record({witness: undefined});
    const swap = jest.fn();
    const result = await drainQueue(swap, T0);

    expect(swap).not.toHaveBeenCalled();
    expect(result).toEqual(drained());
  });

  it('does not re-submit an already settled entry', async () => {
    await record();
    await drainQueue(async () => {}, T0);
    const swap = jest.fn();
    await drainQueue(swap, T0 + 1);
    expect(swap).not.toHaveBeenCalled();
  });

  it('one failure does not stop the others settling', async () => {
    await record({slot: 0});
    await record({slot: 1});
    await record({slot: 2});

    const result = await drainQueue(async e => {
      if (e.id === idOf({slot: 1})) {
        throw new Error('transient');
      }
    }, T0);

    expect(result).toEqual(drained({settled: 2, stillPending: 1}));
  });

  // Two triggers — app foreground and a connectivity change — used to both read
  // the same 'pending' entry and both submit it. The loser took a double-spend
  // rejection and markFailed overwrote the winner's 'settled'.
  it('refuses to run twice at once, so a proof is never submitted twice', async () => {
    await record();

    const second = jest.fn(async () => {});
    let nested: DrainResult | undefined;

    const outer = await drainQueue(async () => {
      nested = await drainQueue(second, T0);
    }, T0);

    expect(second).not.toHaveBeenCalled();
    // Flagged, not a silent no-op: a "Settle now" button fired during the
    // background drain would otherwise report a completed drain that settled
    // nothing and left the exposure exactly where it was.
    expect(nested).toEqual(drained({skipped: true}));
    expect(outer.skipped).toBe(false);
    expect(outer.settled).toBe(1);
    expect((await listSettlements())[0].status).toBe('settled');
  });

  // markSettled returns null when the entry has vanished. Counting that as a
  // settlement reports a persistence that did not happen.
  it('counts an unattributable mint success as lost, not settled', async () => {
    await record();

    const result = await drainQueue(async () => {
      // The entry is pruned out from under the drain, mid-swap.
      storeRaw([]);
    }, T0);

    expect(result).toEqual(drained({lost: 1}));
  });

  it('counts an unattributable failure as lost too', async () => {
    await record();

    const result = await drainQueue(async () => {
      storeRaw([]);
      throw new Error('network unreachable');
    }, T0);

    expect(result).toEqual(drained({lost: 1}));
  });

  // The money is at the mint the instant swap resolves. A write failure after
  // that is a persistence problem, never a settlement failure — marking it
  // 'failed' would write off money the merchant actually received, and leaving
  // it 'pending' would re-submit a proof the mint has already consumed.
  it('does not leave a mint-accepted proof re-submittable when the write fails', async () => {
    await record();

    const swap = jest.fn(async () => {
      mockWriteFails = new Error('keychain write denied');
    });

    const first = await drainQueue(swap, T0);
    expect(first.persistenceErrors).toHaveLength(1);
    expect(first.persistenceErrors[0]).toBeInstanceOf(
      SettlementPersistenceError,
    );
    expect(swap).toHaveBeenCalledTimes(1);

    // Every attempt was retried with a real gap between them, not three
    // failures inside one microtask.
    expect(persistDelays).toEqual([100, 400]);

    // On disk the 'settled' write never landed, but the entry is 'submitting':
    // the claim written before the swap. It is still outstanding, and the next
    // drain must not hand the same proof to the mint again.
    mockWriteFails = null;
    const queued = await listSettlements();
    expect(queued[0].status).toBe('submitting');
    expect(isOutstanding(queued[0])).toBe(true);
    expect(queued[0].lastError).toBeUndefined();

    const second = await drainQueue(swap, T0 + 1);
    expect(swap).toHaveBeenCalledTimes(1); // not re-submitted
    expect(second).toEqual(drained({settled: 1}));
    expect((await listSettlements())[0].status).toBe('settled');
  });

  // Regression: persistSettled was called outside the loop's try, so one
  // unwritable settlement rejected the whole drain — every entry behind it was
  // never attempted, and the count of what did settle went with the throw.
  it('an unwritable settlement does not stop the entries behind it', async () => {
    await record({slot: 0});
    await record({slot: 1});
    await record({slot: 2});

    const swapped: string[] = [];
    const result = await drainQueue(async e => {
      if (e.id === idOf({slot: 0})) {
        // Exactly this entry's three 'settled' attempts are refused; the store
        // is healthy again by the time the next entry needs it.
        mockWriteFailBudget = 3;
      }
      swapped.push(e.id);
    }, T0);

    expect(swapped).toEqual([
      idOf({slot: 0}),
      idOf({slot: 1}),
      idOf({slot: 2}),
    ]);
    expect(result.settled).toBe(2);
    expect(result.persistenceErrors).toHaveLength(1);
    expect(result.persistenceErrors[0]).toBeInstanceOf(
      SettlementPersistenceError,
    );
    expect(result.persistenceErrors[0].message).toContain(idOf({slot: 0}));
  });
});

describe('concurrent mutation', () => {
  it('does not let a background drain clobber a tap recorded mid-flight', async () => {
    await record({slot: 0});
    // Force the two callers to genuinely interleave across the bridge.
    mockLatency = 2;

    await Promise.all([
      record({slot: 1, amount: 25}, T0 + 1),
      markSettled(idOf({slot: 0}), T0 + 1),
    ]);

    mockLatency = 0;
    const queue = await listSettlements();
    // Neither write was lost: the tap survived and the settle stuck.
    expect(queue.map(e => e.id).sort()).toEqual(
      [idOf({slot: 0}), idOf({slot: 1})].sort(),
    );
    expect(queue.find(e => e.id === idOf({slot: 0}))?.status).toBe('settled');
    expect(queue.find(e => e.id === idOf({slot: 1}))?.status).toBe('pending');
  });

  it('a rejected mutation does not poison the ones queued behind it', async () => {
    await record({slot: 0});
    mockLatency = 2;

    const results = await Promise.allSettled([
      record({slot: 1, secret: ''}), // no secret — rejects
      record({slot: 2}),
    ]);

    mockLatency = 0;
    expect(results[0].status).toBe('rejected');
    expect(results[1].status).toBe('fulfilled');
    expect((await listSettlements()).map(e => e.id)).toEqual([
      idOf({slot: 0}),
      idOf({slot: 2}),
    ]);
  });
});

describe('recovery from a lost witness', () => {
  it('re-signing moves needs-card back to pending and it then settles', async () => {
    await record({witness: undefined});

    const recoverable = await recoverableForCard(CARD);
    expect(recoverable.map(e => e.id)).toEqual([idOf()]);

    // The card came back; SIGN_ARBITRARY produced an equally valid witness.
    await attachRecoveredWitness(idOf(), 'aa'.repeat(64), T0 + 10);
    const entry = (await listSettlements())[0];
    expect(entry.status).toBe('pending');
    expect(entry.witness).toBe('aa'.repeat(64));

    expect((await drainQueue(async () => {}, T0 + 11)).settled).toBe(1);
  });

  it('only offers entries belonging to the card in hand', async () => {
    await record({witness: undefined});
    await record({witness: undefined, cardPubkey: OTHER_CARD});
    expect((await recoverableForCard(CARD)).map(e => e.id)).toEqual([idOf()]);
  });

  // A recovery UI can re-tap a card whose entry has already settled. Flipping
  // it back to 'pending' would re-submit a proof the mint has consumed.
  it('will not resurrect a settled entry into the drain loop', async () => {
    await record();
    await drainQueue(async () => {}, T0);

    // Null, not the untouched entry: a truthy return here is indistinguishable
    // from success, and a recovery screen would report a repair that never
    // happened.
    expect(await attachRecoveredWitness(idOf(), 'aa'.repeat(64), T0 + 10)).toBe(
      null,
    );

    const entry = (await listSettlements())[0];
    expect(entry.status).toBe('settled');
    expect(entry.witness).toBe('ef'.repeat(64));

    const swap = jest.fn();
    await drainQueue(swap, T0 + 11);
    expect(swap).not.toHaveBeenCalled();
  });

  it('will not resurrect a permanently failed entry either', async () => {
    await record();
    await markFailed(idOf(), 'malformed proof', T0);

    expect(await attachRecoveredWitness(idOf(), 'aa'.repeat(64), T0 + 10)).toBe(
      null,
    );
    expect((await listSettlements())[0].status).toBe('failed');
  });

  it('returns the repaired entry on the one transition it allows', async () => {
    await record({witness: undefined});

    const repaired = await attachRecoveredWitness(
      idOf(),
      'aa'.repeat(64),
      T0 + 1,
    );
    expect(repaired).not.toBeNull();
    expect(repaired?.status).toBe('pending');
    expect(repaired?.witness).toBe('aa'.repeat(64));
  });

  it('returns null for an id that is not in the queue at all', async () => {
    expect(await attachRecoveredWitness('ghost', 'aa'.repeat(64), T0)).toBe(
      null,
    );
  });

  it('refusing writes nothing at all', async () => {
    await record();
    await markFailed(idOf(), 'malformed proof', T0 + 1);
    const before = mockStore[QUEUE_KEY];

    expect(await attachRecoveredWitness(idOf(), 'aa'.repeat(64), T0 + 10)).toBe(
      null,
    );
    expect(mockStore[QUEUE_KEY]).toBe(before);
  });
});

// The in-memory `mintConfirmed` set evaporates at exactly the boundary this
// module exists to survive: the app killed between the mint accepting a proof
// and the 'settled' write landing. The intent has to be on disk.
describe('an unresolved submission survives a relaunch', () => {
  it('claims the entry as submitting before the swap, so a kill is visible', async () => {
    await record();

    let statusDuringSwap: string | undefined;
    await drainQueue(async () => {
      statusDuringSwap = stored()[0].status;
    }, T0);

    expect(statusDuringSwap).toBe('submitting');
    expect((await listSettlements())[0].status).toBe('settled');
  });

  it('settles, not fails, when the mint rejects a proof it already took', async () => {
    await record({amount: 40});

    // The mint accepted it; the 'settled' write would not land.
    const goodSwap = jest.fn(async () => {
      mockWriteFails = new Error('keychain write denied');
    });
    const first = await drainQueue(goodSwap, T0);
    expect(first.persistenceErrors).toHaveLength(1);
    mockWriteFails = null;
    expect((await listSettlements())[0].status).toBe('submitting');

    // The app is killed here: `mintConfirmed` is gone, the queue is not.
    relaunch();

    const rejectSwap = jest.fn(async () => {
      throw new ProofAlreadySpentError('proof already spent');
    });
    const result = await drainQueue(rejectSwap, T0 + 1);

    expect(rejectSwap).toHaveBeenCalledTimes(1);
    expect(result).toEqual(drained({settled: 1}));
    // Money the merchant actually received is not written off.
    expect((await listSettlements())[0].status).toBe('settled');
    expect((await pendingExposure()).totals).toEqual({});
  });

  // 'submitting' on disk means the *claim* landed, not that the mint saw
  // anything: the claim write happens before the swap. A proof that is simply
  // invalid — a bad C from a flaky NFC read, a rotated keyset — must not be
  // booked as money received just because the process died before submitting.
  it('fails, not settles, when an unresolved entry is rejected as invalid', async () => {
    await killedMidSubmission({amount: 40});
    expect((await listSettlements())[0].status).toBe('submitting');

    const result = await drainQueue(async () => {
      throw new PermanentSettlementError('invalid proof: bad signature');
    }, T0 + 1);

    expect(result).toEqual(drained({failed: 1}));
    const [entry] = await listSettlements();
    expect(entry.status).toBe('failed');
    expect(entry.lastError).toMatch(/bad signature/);
    // Money that left the card and reached no mint is not booked as received.
    const exposure = await pendingExposure();
    expect(exposure.failed).toBe(1);
    expect(exposure.totals).toEqual({});
  });

  it('settles an unresolved entry only on an already-spent response', async () => {
    await killedMidSubmission();

    const result = await drainQueue(async () => {
      throw new ProofAlreadySpentError('11001: Token already spent');
    }, T0 + 1);

    expect(result).toEqual(drained({settled: 1}));
    expect((await listSettlements())[0].status).toBe('settled');
  });

  it('still settles across a relaunch when the mint had never seen it', async () => {
    await record();
    const first = await drainQueue(async () => {
      mockWriteFails = new Error('keychain write denied');
    }, T0);
    expect(first.persistenceErrors).toHaveLength(1);
    mockWriteFails = null;
    relaunch();

    expect((await drainQueue(async () => {}, T0 + 1)).settled).toBe(1);
  });

  it('a first-attempt permanent rejection is still a failure, not a settlement', async () => {
    await record();
    const result = await drainQueue(async () => {
      throw new PermanentSettlementError('malformed proof');
    }, T0);

    expect(result).toEqual(drained({failed: 1}));
    expect((await listSettlements())[0].status).toBe('failed');
  });

  // Even the already-spent response is a failure on a genuinely un-submitted
  // entry: this drain is the first thing that ever claimed it and no earlier
  // attempt left an unknown outcome behind, so the mint is talking about a
  // proof someone else got.
  it('an already-spent response on a genuinely un-submitted entry is a failure', async () => {
    await record();
    expect((await listSettlements())[0].status).toBe('pending');

    const result = await drainQueue(async () => {
      throw new ProofAlreadySpentError('proof already spent');
    }, T0);

    expect(result).toEqual(drained({failed: 1}));
    expect((await listSettlements())[0].status).toBe('failed');
  });

  // The canonical ambiguous failure: the request reaches the mint, the mint
  // accepts it and pays the merchant, and the *response* dies on the way back.
  // Reverting to 'pending' would make the next drain read the mint's `11001`
  // as a first-attempt failure and book money the merchant was paid as lost.
  it('settles, not fails, when the swap that timed out had actually landed', async () => {
    await record({amount: 40});

    const timeout = await drainQueue(async () => {
      throw new Error('socket hang up');
    }, T0);
    expect(timeout).toEqual(drained({stillPending: 1}));
    expect((await listSettlements())[0].status).toBe('submitting');

    const next = await drainQueue(async () => {
      throw new ProofAlreadySpentError('11001: Token already spent');
    }, T0 + 1);

    expect(next).toEqual(drained({settled: 1}));
    const exposure = await pendingExposure();
    expect(exposure.failed).toBe(0);
    expect(exposure.totals).toEqual({});
  });

  // Same thing, but the app was killed in between: the inference has to come
  // off disk, not out of the in-memory drain state.
  it('holds the unknown outcome of a timed-out swap across a relaunch', async () => {
    await record();
    await drainQueue(async () => {
      throw new Error('network reset by peer');
    }, T0);
    relaunch();

    expect((await listSettlements())[0].status).toBe('submitting');
    await drainQueue(async () => {
      throw new ProofAlreadySpentError('proof already spent');
    }, T0 + 1);
    expect((await listSettlements())[0].status).toBe('settled');
  });

  // checkState is gated on the outcome being unknown, so an entry parked by an
  // ambiguous failure has to reach it — that is the cheap way out of the limbo.
  it('asks checkState about an entry an ambiguous failure left behind', async () => {
    await record();
    await drainQueue(async () => {
      throw new Error('timeout');
    }, T0);

    const checkState = jest.fn(async () => 'spent' as const);
    const swap = jest.fn();
    const result = await drainQueue(swap, T0 + 1, {checkState});

    expect(checkState).toHaveBeenCalledTimes(1);
    // Resolved without resubmitting anything.
    expect(swap).not.toHaveBeenCalled();
    expect(result).toEqual(drained({settled: 1}));
  });

  // ...and when the mint says it never took it, the entry is a first attempt
  // again and a permanent rejection is a real failure.
  it('fails an ambiguous entry the mint confirms it never took', async () => {
    await record();
    await drainQueue(async () => {
      throw new Error('timeout');
    }, T0);

    const result = await drainQueue(
      async () => {
        throw new ProofAlreadySpentError('proof already spent');
      },
      T0 + 1,
      {checkState: async () => 'unspent'},
    );

    expect(result).toEqual(drained({failed: 1}));
    expect((await listSettlements())[0].status).toBe('failed');
  });

  // The narrow exception: an adapter that can prove the request never left the
  // device. Only then may the entry go back to being a first attempt.
  it('returns an entry to pending only when the send provably never happened', async () => {
    await record();
    const result = await drainQueue(async () => {
      throw new TransportSettlementError('offline: no network interface');
    }, T0);

    expect(result).toEqual(drained({stillPending: 1}));
    expect((await listSettlements())[0].status).toBe('pending');

    // And because nothing was submitted, an already-spent response next time is
    // still somebody else's spend.
    const next = await drainQueue(async () => {
      throw new ProofAlreadySpentError('proof already spent');
    }, T0 + 1);
    expect(next).toEqual(drained({failed: 1}));
  });

  // A provably-unsent attempt cannot clear an *earlier* attempt's unknown
  // outcome — the proof may already be at the mint from that one.
  it('does not let a provably-unsent retry erase an earlier unknown outcome', async () => {
    await killedMidSubmission();
    expect((await listSettlements())[0].status).toBe('submitting');

    await drainQueue(async () => {
      throw new TransportSettlementError('offline: no network interface');
    }, T0 + 1);
    expect((await listSettlements())[0].status).toBe('submitting');

    await drainQueue(async () => {
      throw new ProofAlreadySpentError('proof already spent');
    }, T0 + 2);
    expect((await listSettlements())[0].status).toBe('settled');
  });

  it('a transient miss on an unresolved entry keeps it unresolved', async () => {
    await record();
    const first = await drainQueue(async () => {
      mockWriteFails = new Error('keychain write denied');
    }, T0);
    expect(first.persistenceErrors).toHaveLength(1);
    mockWriteFails = null;
    relaunch();

    // Offline now: reverting to 'pending' here would let the *next*
    // already-spent response be misread as a real failure.
    await drainQueue(async () => {
      throw new Error('network unreachable');
    }, T0 + 1);
    expect((await listSettlements())[0].status).toBe('submitting');

    relaunch();
    await drainQueue(async () => {
      throw new ProofAlreadySpentError('proof already spent');
    }, T0 + 2);
    expect((await listSettlements())[0].status).toBe('settled');
  });

  it('a submitting entry is money the merchant is still owed', async () => {
    await record({amount: 40});
    const first = await drainQueue(async () => {
      mockWriteFails = new Error('keychain write denied');
    }, T0);
    expect(first.persistenceErrors).toHaveLength(1);
    mockWriteFails = null;

    const exposure = await pendingExposure();
    expect(exposure.totals).toEqual({sat: {amount: 40, count: 1}});
    expect(exposure.count).toBe(1);
    expect(await hasUnsettledForCard(CARD)).toBe(true);
    await expect(clearQueue()).rejects.toThrow(/outstanding/);
  });
});

// Asking the mint beats inferring from the shape of a later rejection.
describe('resolving an unknown outcome with a state check', () => {
  it('settles a spent proof without submitting it again', async () => {
    await killedMidSubmission();

    const swap = jest.fn();
    const result = await drainQueue(swap, T0 + 1, {
      checkState: async () => 'spent',
    });

    expect(swap).not.toHaveBeenCalled();
    expect(result).toEqual(drained({settled: 1}));
    expect((await listSettlements())[0].status).toBe('settled');
  });

  it('treats a rejection as a real failure once the mint says unspent', async () => {
    await killedMidSubmission();

    const result = await drainQueue(
      async () => {
        throw new ProofAlreadySpentError('proof already spent');
      },
      T0 + 1,
      {checkState: async () => 'unspent'},
    );

    // The mint said it did not hold this proof, so a later "already spent" is
    // not this settlement's confirmation.
    expect(result).toEqual(drained({failed: 1}));
    expect((await listSettlements())[0].status).toBe('failed');
  });

  it('leaves the outcome unknown when the check itself fails', async () => {
    await killedMidSubmission();

    const result = await drainQueue(
      async () => {
        throw new ProofAlreadySpentError('proof already spent');
      },
      T0 + 1,
      {
        checkState: async () => {
          throw new Error('offline');
        },
      },
    );

    expect(result).toEqual(drained({settled: 1}));
  });

  it('is not consulted for an entry that was never submitted', async () => {
    await record();
    const checkState = jest.fn(async () => 'unspent' as const);
    await drainQueue(async () => {}, T0, {checkState});
    expect(checkState).not.toHaveBeenCalled();
  });
});

describe('hasUnsettledForCard — the CLEAR_SPENT guard', () => {
  it('is true while the card has outstanding spends', async () => {
    await record();
    // CLEAR_SPENT here would erase the slot data and turn a recoverable burn
    // into a real loss.
    expect(await hasUnsettledForCard(CARD)).toBe(true);
  });

  it('is true for a needs-card entry, which is exactly when erasing is fatal', async () => {
    await record({witness: undefined});
    expect(await hasUnsettledForCard(CARD)).toBe(true);
  });

  it('goes false once everything settles', async () => {
    await record();
    await drainQueue(async () => {}, T0);
    expect(await hasUnsettledForCard(CARD)).toBe(false);
  });

  it('does not confuse one card with another', async () => {
    await record();
    expect(await hasUnsettledForCard(OTHER_CARD)).toBe(false);
  });
});

describe('housekeeping', () => {
  it('pruneSettled removes settled entries only', async () => {
    await record({slot: 0});
    await record({slot: 1});
    await markSettled(idOf({slot: 0}), T0);

    expect(await pruneSettled()).toBe(1);
    expect((await listSettlements()).map(e => e.id)).toEqual([idOf({slot: 1})]);
  });

  it('clearQueue refuses while money is outstanding', async () => {
    await record();
    await expect(clearQueue()).rejects.toThrow(/outstanding/);
    expect(await listSettlements()).toHaveLength(1);
  });

  it('clearQueue works once nothing is outstanding', async () => {
    await record({slot: 0});
    await markSettled(idOf({slot: 0}), T0);
    await clearQueue();
    expect(await listSettlements()).toEqual([]);

    // A permanently failed entry is not outstanding either.
    await record({slot: 1});
    await markFailed(idOf({slot: 1}), 'malformed proof', T0);
    await clearQueue();
    expect(await listSettlements()).toEqual([]);
  });
});

// Nothing used to retire a failed entry: pruneSettled skipped them, clearQueue
// refused while anything was outstanding, and evict dropped only settled ones.
// 200 permanent rejections made the cap inert and left a total wipe — which
// also destroys the evidence — as the operator's only remedy.
describe('retiring a permanently failed entry', () => {
  it('acknowledges only a failed entry', async () => {
    await record({slot: 0});
    await record({slot: 1});
    await markFailed(idOf({slot: 0}), 'malformed proof', T0);

    expect(await acknowledgeFailed(idOf({slot: 0}), T0 + 1)).toMatchObject({
      status: 'failed',
      acknowledgedAt: T0 + 1,
    });
    // Still owed, so there is nothing to reconcile and nothing to retire.
    expect(await acknowledgeFailed(idOf({slot: 1}), T0 + 1)).toBe(null);
    expect(await acknowledgeFailed('ghost', T0 + 1)).toBe(null);
  });

  it('prunes acknowledged failures and keeps the rest as evidence', async () => {
    await record({slot: 0});
    await record({slot: 1});
    await markFailed(idOf({slot: 0}), 'malformed proof', T0);
    await markFailed(idOf({slot: 1}), 'malformed proof', T0);
    await acknowledgeFailed(idOf({slot: 0}), T0 + 1);

    expect(await pruneFailed()).toBe(1);
    expect((await listSettlements()).map(e => e.id)).toEqual([idOf({slot: 1})]);
    // The unreconciled one is still counted against the merchant.
    expect((await pendingExposure()).failed).toBe(1);
  });

  it('lets the cap work again once failures are reconciled', async () => {
    for (let i = 0; i < MAX_QUEUE_ENTRIES; i++) {
      await record({slot: i, amount: 1}, T0 + i);
      await markFailed(idOf({slot: i, amount: 1}), 'malformed proof', T0 + i);
    }
    // Unacknowledged failures are evidence: the cap must not touch them.
    await record({slot: 900, amount: 1}, T0 + 900);
    expect(await listSettlements()).toHaveLength(MAX_QUEUE_ENTRIES + 1);

    await acknowledgeFailed(idOf({slot: 0, amount: 1}), T0);
    await record({slot: 901, amount: 1}, T0 + 901);

    const queue = await listSettlements();
    expect(queue).toHaveLength(MAX_QUEUE_ENTRIES + 1);
    // The reconciled failure is the one that went; nothing outstanding did.
    expect(
      queue.find(e => e.id === idOf({slot: 0, amount: 1})),
    ).toBeUndefined();
    expect(queue.filter(isOutstanding)).toHaveLength(2);
  });
});

describe('durability', () => {
  it('survives a corrupt store rather than taking the till down', async () => {
    mockStore[QUEUE_KEY] = '{ not json';
    expect(await listSettlements()).toEqual([]);
    // And the queue is usable again immediately.
    await record();
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

    await record();
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

  // A corrupt queue is a queue whose outstanding entries are unknown. Reporting
  // a clean till from one is the single answer the merchant must never get, and
  // JSON.parse failure lands in a different arm from a storage failure.
  it('pendingExposure refuses to answer from a corrupt queue', async () => {
    mockStore[QUEUE_KEY] = '{ not json';
    await expect(pendingExposure()).rejects.toBeInstanceOf(
      QueueUnavailableError,
    );
  });

  it('pendingExposure refuses to answer from a non-array blob', async () => {
    mockStore[QUEUE_KEY] = '{"nope":true}';
    await expect(pendingExposure()).rejects.toBeInstanceOf(
      QueueUnavailableError,
    );
  });

  // An empty recoverable list says "nothing to re-tap", which is what turns a
  // recoverable burn into a permanent loss.
  it('recoverableForCard refuses to answer from a corrupt queue', async () => {
    mockStore[QUEUE_KEY] = '{ not json';
    await expect(recoverableForCard(CARD)).rejects.toBeInstanceOf(
      QueueUnavailableError,
    );
  });

  describe('malformed elements inside a well-formed array', () => {
    it.each([
      ['a null element', '{"v":1,"entries":[null]}'],
      ['an object that is not an entry', '{"v":1,"entries":[{"junk":true}]}'],
      ['a primitive', '{"v":1,"entries":["nope"]}'],
    ])(
      'treats %s as corrupt rather than throwing a TypeError',
      async (_label, blob) => {
        mockStore[QUEUE_KEY] = blob;

        // Not `Cannot read properties of null (reading 'status')` from deep
        // inside the module — an error type callers are actually told to expect.
        await expect(pendingExposure()).rejects.toBeInstanceOf(
          QueueUnavailableError,
        );
        await expect(recoverableForCard(CARD)).rejects.toBeInstanceOf(
          QueueUnavailableError,
        );
        expect(await hasUnsettledForCard(CARD)).toBe(true);
        expect(await listSettlements()).toEqual([]);
        expect(mockStore[CORRUPT_QUEUE_KEY]).toBe(blob);
      },
    );

    it('rejects an entry carrying a status outside the union', async () => {
      await record();
      const entries = stored();
      (entries[0] as unknown as {status: string}).status = 'in-flight-ish';
      storeRaw(entries);

      expect(await listSettlements()).toEqual([]);
      await expect(pendingExposure()).rejects.toBeInstanceOf(
        QueueUnavailableError,
      );
    });

    it('keeps the valid entries beside a bad one instead of losing them', async () => {
      await record({slot: 0, amount: 40});
      storeRaw([...stored(), null]);

      // The well-formed settlement is still there to be recovered...
      expect((await listSettlements()).map(e => e.id)).toEqual([
        idOf({slot: 0}),
      ]);
      // ...but the blob as a whole is not vouched for.
      await expect(pendingExposure()).rejects.toBeInstanceOf(
        QueueUnavailableError,
      );
    });

    it('does not blow up a drain — nothing is submitted from a corrupt blob', async () => {
      storeRaw([null]);
      const swap = jest.fn();
      await expect(drainQueue(swap, T0)).resolves.toEqual(drained());
      expect(swap).not.toHaveBeenCalled();
    });
  });

  it('a queued entry is readable after a simulated relaunch', async () => {
    await record({amount: 40});
    const raw = mockStore[QUEUE_KEY];

    // Nothing in memory; only what was written to disk.
    mockStore = {[QUEUE_KEY]: raw};
    const [entry] = await listSettlements();
    expect(entry.amount).toBe(40);
    expect(entry.witness).toBe('ef'.repeat(64));
    expect(entry.secret).toBe(SECRET);
    expect((await pendingExposure()).totals.sat.amount).toBe(40);
  });
});

// The blob is the durable record of money that left a card. Without a version,
// the first release to add a required field classifies every entry the previous
// release wrote as corrupt: quarantined, dropped, and turned into unknown
// exposure the merchant cannot reconcile because the app can no longer read the
// blob it just failed to parse.
describe('stored schema versioning', () => {
  it('writes a versioned envelope, not a bare array', async () => {
    await record();
    const blob = JSON.parse(mockStore[QUEUE_KEY]);
    expect(blob.v).toBe(QUEUE_SCHEMA_VERSION);
    expect(Array.isArray(blob.entries)).toBe(true);
  });

  it('reads a v0 bare array as entries, not as corruption', async () => {
    // Exactly what the previous release wrote: no envelope, no mintUrl, no unit.
    await record({amount: 40});
    mockStore[QUEUE_KEY] = JSON.stringify([asV0(stored()[0])]);

    const queue = await listSettlements();
    expect(queue.map(e => e.id)).toEqual([idOf()]);
    // Not quarantined, and the exposure report still answers.
    expect(mockStore[CORRUPT_QUEUE_KEY]).toBeUndefined();
    expect(mockStore[UNKNOWN_EXPOSURE_KEY]).toBeUndefined();

    const exposure = await pendingExposure();
    expect(exposure.count).toBe(1);
    // The mint and unit were never recorded, so they are shown as unknown
    // rather than guessed at.
    expect(queue[0].mintUrl).toBe(LEGACY_MINT_URL);
    expect(queue[0].unit).toBe(LEGACY_UNIT);
    expect(exposure.totals).toEqual({[LEGACY_UNIT]: {amount: 40, count: 1}});
  });

  it('migrates a v0 entry on the next write', async () => {
    await record({slot: 0, amount: 40});
    mockStore[QUEUE_KEY] = JSON.stringify([asV0(stored()[0])]);

    await record({slot: 1, amount: 25});
    const blob = JSON.parse(mockStore[QUEUE_KEY]);
    expect(blob.v).toBe(QUEUE_SCHEMA_VERSION);
    expect(blob.entries).toHaveLength(2);
    expect(blob.entries[0].unit).toBe(LEGACY_UNIT);
  });

  // The downgrade-then-rollforward shape: a newer build wrote real values, a
  // downgraded build read them forward and re-stamped the blob at its own
  // version, and now the rollout has resumed. The version tag says v0; the
  // fields say otherwise. An arm that overwrites unconditionally replaces the
  // real mint with the stand-in — the adapter then falls back to the
  // configured mint, the proof is rejected as unknown, and owed money is
  // booked as lost.
  it('never overwrites a field a "v0" entry already carries', async () => {
    await record({amount: 40});
    const carried = {
      ...asV0(stored()[0]),
      mintUrl: 'https://forge.flashapp.me',
      unit: 'sat',
    };
    mockStore[QUEUE_KEY] = JSON.stringify([carried]);

    const queue = await listSettlements();
    expect(queue[0].mintUrl).toBe('https://forge.flashapp.me');
    expect(queue[0].unit).toBe('sat');
    expect((await pendingExposure()).totals).toEqual({
      sat: {amount: 40, count: 1},
    });
  });

  it('still settles a v0 entry rather than stranding it', async () => {
    await record({amount: 40});
    mockStore[QUEUE_KEY] = JSON.stringify([asV0(stored()[0])]);

    expect((await drainQueue(async () => {}, T0 + 1)).settled).toBe(1);
  });

  // A staged-rollout rollback — a TestFlight/Play downgrade, a reinstall of an
  // older build — hands this build a newer envelope whose entries it can read
  // perfectly well. Quarantining them dropped them from pendingExposure and
  // recoverableForCard, and the next tap overwrote the blob: settlements no
  // card could ever be re-tapped to recover, against an `unknownSince` flag
  // with nothing behind it to reconcile.
  it('reads a version from the future rather than dropping the money', async () => {
    await record({amount: 40});
    const future = stored().map(e => ({...e, somethingNew: 'v2 only'}));
    storeRaw(future, QUEUE_SCHEMA_VERSION + 1);

    expect((await listSettlements()).map(e => e.id)).toEqual([idOf()]);
    // Readable, so not corrupt: the exposure report still answers and the
    // CLEAR_SPENT gate is driven by the real entry, not by a lost blob.
    expect(mockStore[CORRUPT_QUEUE_KEY]).toBeUndefined();
    expect(mockStore[UNKNOWN_EXPOSURE_KEY]).toBeUndefined();
    expect((await pendingExposure()).totals).toEqual({
      sat: {amount: 40, count: 1},
    });
  });

  it('keeps fields it does not understand when it writes the queue back', async () => {
    await record({slot: 0, amount: 40});
    storeRaw(
      stored().map(e => ({...e, somethingNew: 'v2 only'})),
      QUEUE_SCHEMA_VERSION + 1,
    );

    await record({slot: 1, amount: 25});

    const blob = JSON.parse(mockStore[QUEUE_KEY]);
    // Written back at this build's version...
    expect(blob.v).toBe(QUEUE_SCHEMA_VERSION);
    // ...with both entries, and the newer build's field still on disk for it to
    // find when the rollout rolls forward again.
    expect(blob.entries.map((e: SettlementEntry) => e.id)).toEqual([
      idOf({slot: 0}),
      idOf({slot: 1}),
    ]);
    expect(blob.entries[0].somethingNew).toBe('v2 only');
  });

  it('still settles an entry from a newer envelope', async () => {
    await record({amount: 40});
    storeRaw(stored(), QUEUE_SCHEMA_VERSION + 1);

    expect((await drainQueue(async () => {}, T0 + 1)).settled).toBe(1);
  });

  // Forward-compatible is not credulous: an envelope with no usable shape at
  // all is still corrupt, and still fails closed.
  it.each([
    ['a non-numeric version', {v: 'two', entries: []}],
    ['a negative version', {v: -1, entries: []}],
    ['entries that are not an array', {v: 1, entries: {}}],
  ])('treats %s as corrupt', async (_label, blob) => {
    await record();
    mockStore[QUEUE_KEY] = JSON.stringify(blob);

    expect(await listSettlements()).toEqual([]);
    await expect(pendingExposure()).rejects.toBeInstanceOf(
      QueueUnavailableError,
    );
    expect(await hasUnsettledForCard(CARD)).toBe(true);
  });
});

// Corruption is detectable exactly once. Before this, the first write over a
// corrupt blob produced a queue that parsed cleanly, reported `corrupt: false`,
// and omitted every outstanding settlement — the merchant was never told they
// were carrying money the queue no longer knew about.
describe('corruption outlives the write that hides it', () => {
  it('flags unknown exposure after a corrupt queue has been written over', async () => {
    mockStore[QUEUE_KEY] = '{ not json';

    await record({amount: 40});

    // The queue parses fine now and holds exactly the new entry...
    expect((await listSettlements()).map(e => e.id)).toEqual([idOf()]);
    // ...but the exposure report still says part of the till is unaccounted for.
    const exposure = await pendingExposure();
    expect(exposure.totals).toEqual({sat: {amount: 40, count: 1}});
    expect(exposure.unknownSince).toBeDefined();
    expect(typeof exposure.unknownSince).toBe('number');
  });

  it('records the corruption before the overwrite, not after', async () => {
    mockStore[QUEUE_KEY] = '{ not json';
    // A plain read is enough — the marker must exist before any writer runs.
    await listSettlements();
    expect(mockStore[UNKNOWN_EXPOSURE_KEY]).toBeDefined();
    const marker = JSON.parse(mockStore[UNKNOWN_EXPOSURE_KEY]);
    expect(marker).toEqual({
      since: expect.any(Number),
      quarantineKey: expect.any(String),
    });
    // The key it names holds the bytes it is talking about.
    expect(marker.quarantineKey).toBe(quarantineKeyFor('{ not json'));
    expect(mockStore[marker.quarantineKey]).toBe('{ not json');
  });

  // `quarantine` runs from every *read* path, and a corrupt blob is only
  // cleared by the next write — so between launch and the next tap, an exposure
  // banner polling pendingExposure() re-detects the same corruption over and
  // over. A clock-keyed slot minted a full copy of the corrupt queue on every
  // one of those reads, with nothing to prune them.
  it('does not mint a new quarantine copy on every read of the same blob', async () => {
    mockStore[QUEUE_KEY] = '{ not json';

    for (let i = 0; i < 5; i++) {
      await listSettlements();
      await expect(pendingExposure()).rejects.toBeInstanceOf(
        QueueUnavailableError,
      );
      await hasUnsettledForCard(CARD);
    }

    expect(
      Object.keys(mockStore).filter(k => k.startsWith(`${CORRUPT_QUEUE_KEY}:`)),
    ).toEqual([quarantineKeyFor('{ not json')]);
  });

  // Distinct keys bounded storage; this bounds the write *rate*. Without it,
  // every poll of a corrupt queue re-wrote byte-identical copies — an exposure
  // banner polling once a second ground the Keychain at two writes per second
  // for as long as the app stayed open, since taps may be hours apart.
  it('writes the quarantine copy once, not on every poll of a corrupt queue', async () => {
    const {setSecure} = jest.requireMock(
      '../../src/services/secureStorage',
    ) as {setSecure: jest.Mock};
    mockStore[QUEUE_KEY] = '{ not json';

    await listSettlements(); // first detection: copy, pointer, marker
    const afterFirst = setSecure.mock.calls.length;

    for (let i = 0; i < 5; i++) {
      await listSettlements();
      await hasUnsettledForCard(CARD);
    }
    expect(setSecure.mock.calls.length).toBe(afterFirst);

    // A relaunch forgets what this process wrote and must re-verify the copy —
    // the guard is an in-process rate bound, not a durable claim.
    relaunch();
    await listSettlements();
    // The content copy and the bare pointer are rewritten; the marker already
    // exists and is not.
    expect(setSecure.mock.calls.length).toBe(afterFirst + 2);
  });

  it('keeps the CLEAR_SPENT gate shut while exposure is unknown', async () => {
    mockStore[QUEUE_KEY] = '{ not json';
    await record();
    await drainQueue(async () => {}, T0);

    // Nothing outstanding in the queue, yet erasing spent slots is still
    // unsafe: the lost blob may have held this card's burns.
    expect(await listSettlements()).toHaveLength(1);
    expect(await hasUnsettledForCard(CARD)).toBe(true);
  });

  it('does not reset the clock when the queue is corrupted a second time', async () => {
    mockStore[QUEUE_KEY] = '{ not json';
    await listSettlements();
    const first = mockStore[UNKNOWN_EXPOSURE_KEY];

    mockStore[QUEUE_KEY] = '[null]';
    await listSettlements();

    expect(mockStore[UNKNOWN_EXPOSURE_KEY]).toBe(first);

    // And the bytes the marker names are still the ones it was written about.
    // A single shared quarantine key would have left the marker saying
    // "unreconciled since T1" while pointing at the T2 bytes, so an operator
    // would reconcile against the wrong blob and then acknowledge money they
    // never accounted for.
    const marker = JSON.parse(first);
    expect(mockStore[marker.quarantineKey]).toBe('{ not json');
    // The second blob is kept too, under its own content-derived key.
    expect(mockStore[CORRUPT_QUEUE_KEY]).toBe('[null]');
    expect(mockStore[quarantineKeyFor('[null]')]).toBe('[null]');
    expect(
      Object.keys(mockStore)
        .filter(k => k.startsWith(`${CORRUPT_QUEUE_KEY}:`))
        .sort(),
    ).toEqual(
      [quarantineKeyFor('{ not json'), quarantineKeyFor('[null]')].sort(),
    );
  });

  it('clears only on an explicit operator acknowledgement', async () => {
    mockStore[QUEUE_KEY] = '{ not json';
    await record();
    expect((await pendingExposure()).unknownSince).toBeDefined();

    // Draining, settling and pruning all leave the flag alone.
    await drainQueue(async () => {}, T0);
    await pruneSettled();
    expect((await pendingExposure()).unknownSince).toBeDefined();

    await acknowledgeUnknownExposure();
    expect((await pendingExposure()).unknownSince).toBeUndefined();
    expect(await hasUnsettledForCard(CARD)).toBe(false);
  });

  it('still flags when the marker itself is unreadable garbage', async () => {
    mockStore[UNKNOWN_EXPOSURE_KEY] = 'not json either';
    // Present-but-unparseable is still "we lost track once".
    expect((await pendingExposure()).unknownSince).toBe(0);
  });

  // If the marker cannot be written, the overwrite is the thing that destroys
  // the evidence — so the overwrite is what gets refused.
  it('refuses to overwrite a corrupt queue it could not record', async () => {
    mockStore[QUEUE_KEY] = '{ not json';
    mockWriteFails = new Error('keychain write denied');
    mockWriteFailsOnlyFor = UNKNOWN_EXPOSURE_KEY;

    await expect(record()).rejects.toBeInstanceOf(QueueUnavailableError);
    expect(mockStore[QUEUE_KEY]).toBe('{ not json');

    // Once the marker lands, the queue is usable again.
    mockWriteFails = null;
    await record();
    expect((await listSettlements()).map(e => e.id)).toEqual([idOf()]);
    expect(mockStore[UNKNOWN_EXPOSURE_KEY]).toBeDefined();
  });
});

describe('an unreadable store is not an empty one', () => {
  it('recordSpend refuses to write over a queue it could not read', async () => {
    await record({slot: 0});
    const before = mockStore[QUEUE_KEY];

    mockReadFails = new Error('keychain locked');
    await expect(record({slot: 1})).rejects.toBeInstanceOf(
      QueueUnavailableError,
    );

    // The outstanding entry is untouched — no write happened at all.
    mockReadFails = null;
    expect(mockStore[QUEUE_KEY]).toBe(before);
    expect((await listSettlements()).map(e => e.id)).toEqual([idOf({slot: 0})]);
  });

  it('hasUnsettledForCard fails closed so CLEAR_SPENT stays blocked', async () => {
    mockReadFails = new Error('keychain locked');
    expect(await hasUnsettledForCard(CARD)).toBe(true);
  });

  it('pendingExposure refuses to report a clean till it cannot vouch for', async () => {
    await record({amount: 40});
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
    await record({slot: 0});
    mockReadFails = new Error('keychain locked');
    await expect(listSettlements()).rejects.toBeInstanceOf(
      QueueUnavailableError,
    );

    mockReadFails = null;
    await record({slot: 1});
    expect((await listSettlements()).map(e => e.id)).toEqual([
      idOf({slot: 0}),
      idOf({slot: 1}),
    ]);
  });
});
