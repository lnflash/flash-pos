/**
 * cashuAutoSettle — the automatic settle-then-sweep orchestration.
 *
 * The pipeline's collaborators (queue drain, melt, exposure read) are mocked
 * at their service boundaries; what is under test is the orchestration policy:
 * drain always runs, the sweep only runs when something settled and an
 * account is logged in, sweep failures surface as result fields (never as
 * rejections — a failed payout must not look like a failed settlement), and
 * concurrent triggers collapse into one run.
 */
import {
  cashuOutstanding,
  runAutoSettlement,
  type AutoSettleResult,
} from '../../src/services/cashuAutoSettle';
import {FLASH_LN_ADDRESS, FLASH_LN_ADDRESS_URL} from '@env';

const mockSettlePending = jest.fn();
const mockMeltSettledProofs = jest.fn();
const mockListSettledProofs = jest.fn();
const mockPendingExposure = jest.fn();

jest.mock('../../src/services/cashuSpend', () => ({
  ...jest.requireActual('../../src/services/cashuSpend'),
  settlePending: (...args: unknown[]) => mockSettlePending(...args),
}));

jest.mock('../../src/services/cashuMint', () => ({
  ...jest.requireActual('../../src/services/cashuMint'),
  meltSettledProofs: (...args: unknown[]) => mockMeltSettledProofs(...args),
  listSettledProofs: (...args: unknown[]) => mockListSettledProofs(...args),
}));

jest.mock('../../src/services/cashuSettlement', () => ({
  ...jest.requireActual('../../src/services/cashuSettlement'),
  pendingExposure: (...args: unknown[]) => mockPendingExposure(...args),
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockSettlePending.mockResolvedValue({settled: 0, stillPending: 0, failed: 0, lost: 0});
  mockListSettledProofs.mockResolvedValue([]);
  mockPendingExposure.mockResolvedValue({totals: {}, count: 0});
  mockMeltSettledProofs.mockResolvedValue({
    paidSat: 16,
    feeReserveSat: 0,
    preimage: 'pre',
    change: [],
  });
});

describe('runAutoSettlement', () => {
  it('drains, then sweeps the settled store to the logged-in account', async () => {
    mockSettlePending.mockResolvedValue({settled: 1, stillPending: 0, failed: 0, lost: 0});
    mockListSettledProofs.mockResolvedValue([
      {id: 'k', amount: 16, secret: 's', C: 'c', mintUrl: 'https://forge.flashapp.me'},
    ]);

    const result = await runAutoSettlement('merchant');

    expect(result.paidSat).toBe(16);
    expect(mockMeltSettledProofs).toHaveBeenCalledWith(
      expect.objectContaining({
        // The account address, resolved through the flash ln-address service
        // (the display domain and the LNURL endpoint are different hosts).
        lightningAddress: `merchant@${FLASH_LN_ADDRESS}`,
        lnurlpUrl: FLASH_LN_ADDRESS_URL,
      }),
    );
  });

  it('an empty run (offline drain held everything) skips the sweep', async () => {
    const result = await runAutoSettlement('merchant');
    expect(result.settled).toBe(0);
    expect(result.skippedPayout).toBe('nothing settled to sweep');
    expect(mockMeltSettledProofs).not.toHaveBeenCalled();
  });

  it('drains even when not logged in, but does not sweep', async () => {
    mockSettlePending.mockResolvedValue({settled: 1, stillPending: 0, failed: 0, lost: 0});
    mockListSettledProofs.mockResolvedValue([
      {id: 'k', amount: 4, secret: 's', C: 'c', mintUrl: 'https://forge.flashapp.me'},
    ]);

    const result = await runAutoSettlement(undefined);
    expect(result.settled).toBe(1);
    expect(result.skippedPayout).toBe('no logged-in account to sweep to');
    expect(mockMeltSettledProofs).not.toHaveBeenCalled();
  });

  it('a sweep failure surfaces as payoutError, not a thrown settlement', async () => {
    mockSettlePending.mockResolvedValue({settled: 1, stillPending: 0, failed: 0, lost: 0});
    mockListSettledProofs.mockResolvedValue([
      {id: 'k', amount: 4, secret: 's', C: 'c', mintUrl: 'https://forge.flashapp.me'},
    ]);
    mockMeltSettledProofs.mockRejectedValue(new Error('lightning address unreachable'));

    const result: AutoSettleResult = await runAutoSettlement('merchant');
    expect(result.paidSat).toBeNull();
    expect(result.payoutError).toBe('lightning address unreachable');
  });

  it('collapses concurrent triggers into a single run', async () => {
    mockSettlePending.mockResolvedValue({settled: 1, stillPending: 0, failed: 0, lost: 0});
    mockListSettledProofs.mockResolvedValue([
      {id: 'k', amount: 4, secret: 's', C: 'c', mintUrl: 'https://forge.flashapp.me'},
    ]);

    // A foreground event and a completed tap landing in the same tick.
    const [a, b] = await Promise.all([
      runAutoSettlement('merchant'),
      runAutoSettlement('merchant'),
    ]);
    expect(a.ran).toBe(true);
    expect(b.ran).toBe(true);
    expect(mockSettlePending).toHaveBeenCalledTimes(1);
  });
});

describe('cashuOutstanding', () => {
  it('splits the two legs: queue (unswapped) and settled (unswept)', async () => {
    mockPendingExposure.mockResolvedValue({
      totals: {sat: {amount: 21, count: 2}},
      count: 2,
    });
    mockListSettledProofs.mockResolvedValue([
      {id: 'k', amount: 16, secret: 's', C: 'c', mintUrl: 'https://forge.flashapp.me'},
    ]);

    await expect(cashuOutstanding()).resolves.toEqual({
      queueSat: 21,
      queueCount: 2,
      settledSat: 16,
    });
  });

  it('an empty till reads zero without a sat key', async () => {
    mockPendingExposure.mockResolvedValue({totals: {}, count: 0});
    mockListSettledProofs.mockResolvedValue([]);
    await expect(cashuOutstanding()).resolves.toEqual({
      queueSat: 0,
      queueCount: 0,
      settledSat: 0,
    });
  });
});
