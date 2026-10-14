/**
 * PendingSettlementBanner — what the merchant reads about money the terminal
 * holds. ENG-696: protocol 2.0 keeps no till float (the card makes its own
 * change), so everything settled sweeps once the till reaches the minimum
 * sweep; the banner must neither promise a float nor hold sats back as one.
 */
import React from 'react';
import {act, render} from '@testing-library/react-native';
import {Provider} from 'react-redux';
import {configureStore} from '@reduxjs/toolkit';

import PendingSettlementBanner from '../../../src/components/cashu/PendingSettlementBanner';
import {
  SWEEP_MIN_SAT,
  type CashuOutstanding,
} from '../../../src/services/cashuAutoSettle';
import rootReducer from '../../../src/store/reducers';

const mockCashuOutstanding = jest.fn();

jest.mock('../../../src/services/cashuAutoSettle', () => ({
  ...jest.requireActual('../../../src/services/cashuAutoSettle'),
  cashuOutstanding: (...args: unknown[]) => mockCashuOutstanding(...args),
  lastAutoSettleResult: () => null,
  runAutoSettlement: jest.fn(),
}));

jest.mock('../../../src/utils/toast', () => ({
  toastShow: jest.fn(),
}));

const outstanding = (over: Partial<CashuOutstanding>): CashuOutstanding => ({
  queueSat: 0,
  queueCount: 0,
  settledSat: 0,
  failedCount: 0,
  failedSat: 0,
  ...over,
});

async function renderBanner(o: CashuOutstanding) {
  mockCashuOutstanding.mockResolvedValue(o);
  const store = configureStore({reducer: rootReducer});
  const utils = render(
    <Provider store={store}>
      <PendingSettlementBanner />
    </Provider>,
  );
  await act(async () => {});
  return utils;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('PendingSettlementBanner (ENG-696)', () => {
  it('names everything settled as sweeping, with no float held back', async () => {
    const {getByText, queryByText, unmount} = await renderBanner(
      outstanding({settledSat: 25}),
    );
    expect(getByText('⚠ 25 sat in the till (25 sat to sweep)')).toBeTruthy();
    expect(
      getByText(
        '25 sat settled at the mint; it sweeps to your wallet when online.',
      ),
    ).toBeTruthy();
    expect(queryByText(/float/)).toBeNull();
    unmount();
  });

  it('a till under the minimum says when it will sweep', async () => {
    expect(SWEEP_MIN_SAT).toBe(10);
    const {getByText, queryByText, unmount} = await renderBanner(
      outstanding({settledSat: 9}),
    );
    expect(
      getByText(
        '9 sat settled at the mint; it sweeps to your wallet once the till reaches 10 sat.',
      ),
    ).toBeTruthy();
    expect(queryByText(/float/)).toBeNull();
    unmount();
  });

  it('counts the queue in the till, but only settled sats as sweeping', async () => {
    const {getByText, unmount} = await renderBanner(
      outstanding({queueSat: 8, queueCount: 1, settledSat: 12}),
    );
    expect(getByText('⚠ 20 sat in the till (12 sat to sweep)')).toBeTruthy();
    unmount();
  });
});
