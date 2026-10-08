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
});
