/**
 * CashuAutoSettle — the glue between the automatic settle loop and the
 * screen. The policies (what to toast, when to run next) are the service's
 * pure functions and are tested there; this pins that the component defers
 * to them: one run on mount, the toast the policy returns and nothing when
 * it returns null.
 */
import React from 'react';
import {act, render} from '@testing-library/react-native';
import {Provider} from 'react-redux';
import {configureStore} from '@reduxjs/toolkit';

import CashuAutoSettle from '../../../src/components/cashu/CashuAutoSettle';
import {
  RATE_LIMITED_PAYOUT,
  type AutoSettleResult,
} from '../../../src/services/cashuAutoSettle';
import rootReducer from '../../../src/store/reducers';
import {setUserData} from '../../../src/store/slices/userSlice';

const mockRunAutoSettlement = jest.fn();
const mockToastShow = jest.fn();

jest.mock('../../../src/services/cashuAutoSettle', () => ({
  ...jest.requireActual('../../../src/services/cashuAutoSettle'),
  autoSettleInFlight: () => false,
  runAutoSettlement: (...args: unknown[]) => mockRunAutoSettlement(...args),
}));

jest.mock('../../../src/utils/toast', () => ({
  toastShow: (...args: unknown[]) => mockToastShow(...args),
}));

const result = (over: Partial<AutoSettleResult>): AutoSettleResult => ({
  ran: true,
  settled: 0,
  stillPending: 0,
  paidSat: null,
  rateLimited: false,
  ...over,
});

const flush = () => act(async () => {});

function renderWithUser(username: string) {
  const store = configureStore({reducer: rootReducer});
  store.dispatch(setUserData({username}));
  return render(
    <Provider store={store}>
      <CashuAutoSettle />
    </Provider>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('CashuAutoSettle', () => {
  it('runs the pipeline for the logged-in account on mount', async () => {
    mockRunAutoSettlement.mockResolvedValue(result({}));
    const {unmount} = renderWithUser('merchant');
    await flush();
    expect(mockRunAutoSettlement).toHaveBeenCalledWith('merchant');
    expect(mockToastShow).not.toHaveBeenCalled();
    unmount();
  });

  it('toasts what the policy returns: a payout, a payout failure', async () => {
    mockRunAutoSettlement.mockResolvedValueOnce(result({paidSat: 21}));
    const first = renderWithUser('merchant');
    await flush();
    expect(mockToastShow).toHaveBeenCalledWith({
      message: 'eCash: paid out 21 sat to your wallet',
      type: 'success',
    });
    first.unmount();

    mockToastShow.mockClear();
    mockRunAutoSettlement.mockResolvedValueOnce(
      result({payoutError: 'lightning address unreachable'}),
    );
    const second = renderWithUser('merchant');
    await flush();
    expect(mockToastShow).toHaveBeenCalledWith({
      message: 'eCash payout pending: lightning address unreachable',
      type: 'error',
    });
    second.unmount();
  });

  it('a throttled run does not toast (ENG-626)', async () => {
    mockRunAutoSettlement.mockResolvedValue(
      result({payoutError: RATE_LIMITED_PAYOUT, rateLimited: true}),
    );
    const {unmount} = renderWithUser('merchant');
    await flush();
    expect(mockRunAutoSettlement).toHaveBeenCalled();
    expect(mockToastShow).not.toHaveBeenCalled();
    unmount();
  });

  it('does not run without a logged-in account', async () => {
    const {unmount} = renderWithUser('');
    await flush();
    expect(mockRunAutoSettlement).not.toHaveBeenCalled();
    unmount();
  });

  describe('the timer', () => {
    // Leave the microtask machinery real: faking it stalls promise chains
    // under Node 22 (the CI runtime).
    const FAKE_TIMERS: Parameters<typeof jest.useFakeTimers>[0] = {
      doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'],
    };
    const advance = (ms: number) =>
      act(async () => {
        await jest.advanceTimersByTimeAsync(ms);
      });

    beforeEach(() => {
      jest.useFakeTimers(FAKE_TIMERS);
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('arms the next tick on the verdict of the run that just finished (ENG-626)', async () => {
      // A throttled first run must push the second tick out to 40 s. Arming
      // the timer before the run settled scheduled it on the previous
      // delay, so forge took one more 20 s hit before the backoff applied.
      mockRunAutoSettlement
        .mockResolvedValueOnce(
          result({payoutError: RATE_LIMITED_PAYOUT, rateLimited: true}),
        )
        .mockResolvedValue(result({}));
      const {unmount} = renderWithUser('merchant');
      await flush();
      expect(mockRunAutoSettlement).toHaveBeenCalledTimes(1);

      await advance(20_000);
      expect(mockRunAutoSettlement).toHaveBeenCalledTimes(1);
      await advance(19_999);
      expect(mockRunAutoSettlement).toHaveBeenCalledTimes(1);
      await advance(1);
      expect(mockRunAutoSettlement).toHaveBeenCalledTimes(2);

      // The clean second run snaps the cadence back to the baseline at once,
      // not one tick later.
      await advance(20_000);
      expect(mockRunAutoSettlement).toHaveBeenCalledTimes(3);
      unmount();
    });

    it('a run that settles after unmount does not re-arm the timer', async () => {
      let finish: (value: AutoSettleResult) => void = () => {};
      mockRunAutoSettlement.mockImplementationOnce(
        () =>
          new Promise<AutoSettleResult>(resolve => {
            finish = resolve;
          }),
      );
      const {unmount} = renderWithUser('merchant');
      await flush();
      expect(mockRunAutoSettlement).toHaveBeenCalledTimes(1);

      unmount();
      await act(async () => {
        finish(result({}));
      });
      await advance(60_000);
      expect(mockRunAutoSettlement).toHaveBeenCalledTimes(1);
    });
  });
});
