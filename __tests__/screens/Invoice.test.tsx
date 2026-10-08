import React from 'react';
import {act, render, waitFor} from '@testing-library/react-native';
import {Provider} from 'react-redux';
import {configureStore} from '@reduxjs/toolkit';
import Toast from 'react-native-toast-message';
import Invoice from '../../src/screens/Invoice';
import rootReducer from '../../src/store/reducers';

const mockUseSubscription = jest.fn();
const mockUseLazyQuery = jest.fn();
const mockResetFlashcard = jest.fn();
const mockGetAllStoredCards = jest.fn(() => Promise.resolve([]));
const mockUseFlashcard = jest.fn();
const idleFlashcard = () => ({
  loading: false,
  resetFlashcard: mockResetFlashcard,
  getAllStoredCards: mockGetAllStoredCards,
});
const invoiceUnavailableMessage =
  'Please try again. Either the invoice has expired or it has not been paid.';

jest.mock('@apollo/client', () => ({
  gql: (strings: TemplateStringsArray) => strings.join(''),
  useSubscription: (...args: unknown[]) => mockUseSubscription(...args),
  useLazyQuery: (...args: unknown[]) => mockUseLazyQuery(...args),
}));

jest.mock('../../src/hooks/useCardPaymentRouter', () => ({
  useCardPaymentRouter: () => async () => false,
}));

// Like the real hook on a focused screen: runs after commit, and again
// whenever the callback's identity changes.
jest.mock('@react-navigation/native', () => {
  const MockReact = require('react');

  return {
    useFocusEffect: (callback: () => void | (() => void)) => {
      MockReact.useEffect(callback, [callback]);
    },
  };
});

jest.mock('../../src/components', () => {
  const MockReact = require('react');
  const {Text} = require('react-native');

  return {
    Amount: () => MockReact.createElement(Text, null, 'Amount'),
    ExpireTime: () => MockReact.createElement(Text, null, 'ExpireTime'),
    InvoiceQRCode: ({errMessage}: {errMessage?: string}) =>
      MockReact.createElement(Text, null, errMessage || 'InvoiceQRCode'),
    NfcButton: () => null,
    PrimaryButton: () => MockReact.createElement(Text, null, 'PrimaryButton'),
    TextButton: () => MockReact.createElement(Text, null, 'TextButton'),
  };
});

jest.mock('../../src/contexts/ActivityIndicator', () => {
  const MockReact = require('react');
  const {Text} = require('react-native');

  return {
    ActivityIndicator: () => MockReact.createElement(Text, null, 'Loading'),
  };
});

jest.mock('../../src/hooks', () => ({
  useFlashcard: () => mockUseFlashcard(),
}));

jest.mock('@react-native-clipboard/clipboard', () => ({
  setString: jest.fn(),
}));

const mockAxiosPost = jest.fn((..._args: unknown[]) =>
  Promise.resolve({data: {}}),
);
jest.mock('axios', () => ({
  __esModule: true,
  default: {post: (...args: unknown[]) => mockAxiosPost(...args)},
}));

const paidSubscriptionData = {
  lnInvoicePaymentStatus: {
    status: 'PAID',
    errors: [],
  },
};

const pendingSubscriptionData = {
  lnInvoicePaymentStatus: {
    status: 'PENDING',
    errors: [],
  },
};

const erroredSubscriptionData = {
  lnInvoicePaymentStatus: {
    status: undefined,
    errors: [
      {
        message: 'Invoice lookup is not ready yet',
        __typename: 'Error',
      },
    ],
  },
};

const expiredSubscriptionData = {
  lnInvoicePaymentStatus: {
    status: 'EXPIRED',
    errors: [],
  },
};

const deferredStatus = (status: string) => {
  let resolveStatus!: (value: unknown) => void;
  const promise = new Promise(resolve => {
    resolveStatus = resolve;
  });
  const confirmStatus = jest.fn(() => promise);

  return {
    confirmStatus,
    resolve: () =>
      resolveStatus({
        data: {
          lnInvoicePaymentStatus: {
            status,
            errors: [],
          },
        },
      }),
  };
};

const deferredStatusWithErrors = () => {
  let resolveStatus!: (value: unknown) => void;
  const promise = new Promise(resolve => {
    resolveStatus = resolve;
  });
  const confirmStatus = jest.fn(() => promise);

  return {
    confirmStatus,
    resolve: () =>
      resolveStatus({
        data: {
          lnInvoicePaymentStatus: {
            status: undefined,
            errors: [
              {
                message: 'Invoice lookup is not ready yet',
                __typename: 'Error',
              },
            ],
          },
        },
      }),
  };
};

type RenderOptions = {
  /** Reward slice state to preload (rewards are off unless given). */
  reward?: Record<string, unknown>;
};

const renderInvoice = ({reward}: RenderOptions = {}) => {
  const store = configureStore({
    reducer: rootReducer,
    preloadedState: {
      ...(reward ? {reward} : {}),
      amount: {
        satAmount: '1000',
        displayAmount: '10.00',
        currency: {id: 'USD', symbol: '$', flag: '', name: 'US Dollar'},
        isPrimaryAmountSats: false,
        memo: 'test invoice',
        loading: false,
        error: '',
      },
      invoice: {
        paymentHash: 'payment-hash-1',
        paymentRequest: 'lnbc1000n1ptest',
        paymentSecret: 'payment-secret-1',
        loading: false,
        error: '',
      },
      user: {
        username: 'merchant',
        walletId: 'wallet-id',
      },
    } as any,
  });
  const navigation = {
    replace: jest.fn(),
    goBack: jest.fn(),
  };

  const tree = () => (
    <Provider store={store}>
      <Invoice navigation={navigation as any} route={{} as any} />
    </Provider>
  );
  const view = render(tree());

  return {
    store,
    navigation,
    ...view,
    rerenderInvoice: () => view.rerender(tree()),
  };
};

describe('Invoice screen payment confirmation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseFlashcard.mockImplementation(idleFlashcard);
    mockUseSubscription.mockReturnValue({
      data: paidSubscriptionData,
      error: undefined,
    });
  });

  it('keeps showing the QR code while the invoice is pending', () => {
    mockUseSubscription.mockReturnValue({
      data: pendingSubscriptionData,
      error: undefined,
    });
    mockUseLazyQuery.mockReturnValue([jest.fn()]);

    const {getByText, queryByText, store, navigation} = renderInvoice();

    expect(navigation.replace).not.toHaveBeenCalled();
    expect(store.getState().transactionHistory.transactions).toHaveLength(0);
    expect(store.getState().invoice.paymentRequest).toBe('lnbc1000n1ptest');
    expect(getByText('InvoiceQRCode')).toBeTruthy();
    expect(queryByText(invoiceUnavailableMessage)).toBeNull();
  });

  it('keeps showing the QR code when the initial subscription status lookup errors', () => {
    mockUseSubscription.mockReturnValue({
      data: erroredSubscriptionData,
      error: undefined,
    });
    mockUseLazyQuery.mockReturnValue([jest.fn()]);

    const {getByText, queryByText, store, navigation} = renderInvoice();

    expect(navigation.replace).not.toHaveBeenCalled();
    expect(store.getState().transactionHistory.transactions).toHaveLength(0);
    expect(store.getState().invoice.paymentRequest).toBe('lnbc1000n1ptest');
    expect(getByText('InvoiceQRCode')).toBeTruthy();
    expect(queryByText(invoiceUnavailableMessage)).toBeNull();
  });

  it('ignores a paid subscription event when the status query says pending', async () => {
    const {confirmStatus, resolve} = deferredStatus('PENDING');
    mockUseLazyQuery.mockReturnValue([confirmStatus]);

    const {getByText, queryByText, store, navigation} = renderInvoice();

    await waitFor(() => expect(confirmStatus).toHaveBeenCalled());
    await act(async () => {
      resolve();
      await Promise.resolve();
    });

    expect(navigation.replace).not.toHaveBeenCalled();
    expect(store.getState().transactionHistory.transactions).toHaveLength(0);
    expect(getByText('InvoiceQRCode')).toBeTruthy();
    expect(queryByText(invoiceUnavailableMessage)).toBeNull();
  });

  it('ignores a paid subscription event when the confirmation status lookup errors', async () => {
    const {confirmStatus, resolve} = deferredStatusWithErrors();
    mockUseLazyQuery.mockReturnValue([confirmStatus]);

    const {getByText, queryByText, store, navigation} = renderInvoice();

    await waitFor(() => expect(confirmStatus).toHaveBeenCalled());
    await act(async () => {
      resolve();
      await Promise.resolve();
    });

    expect(navigation.replace).not.toHaveBeenCalled();
    expect(store.getState().transactionHistory.transactions).toHaveLength(0);
    expect(getByText('InvoiceQRCode')).toBeTruthy();
    expect(queryByText(invoiceUnavailableMessage)).toBeNull();
  });

  it('stores the transaction only after the status query confirms paid', async () => {
    const {confirmStatus, resolve} = deferredStatus('PAID');
    mockUseLazyQuery.mockReturnValue([confirmStatus]);

    const {store, navigation} = renderInvoice();

    await waitFor(() => expect(confirmStatus).toHaveBeenCalled());
    await act(async () => {
      resolve();
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(navigation.replace).toHaveBeenCalledWith('Success'),
    );

    expect(store.getState().transactionHistory.transactions).toHaveLength(1);
  });

  it('shows an invoice error after the subscription reports expired', () => {
    mockUseSubscription.mockReturnValue({
      data: expiredSubscriptionData,
      error: undefined,
    });
    mockUseLazyQuery.mockReturnValue([jest.fn()]);

    const {getByText, navigation} = renderInvoice();

    expect(navigation.replace).not.toHaveBeenCalled();
    expect(getByText(invoiceUnavailableMessage)).toBeTruthy();
  });
});

// ENG-627: a BoltCard k1 is single-use. BTCPay charges the card on the first
// withdraw callback and answers "Replayed or expired query" to a repeat, so
// one tap must produce exactly one request however often the screen renders.
describe('Invoice screen Flashcard withdraw callback', () => {
  const FAKE_TIMERS: Parameters<typeof jest.useFakeTimers>[0] = {
    doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'],
  };
  const tappedK1 = 'p-value-c-value';
  const tappedCallback = 'https://btcpay.example/boltcard';
  const fetchMock = jest.fn();
  const originalFetch = global.fetch;
  const toastShow = Toast.show as jest.Mock;

  // A tapped card whose resetFlashcard is a fresh function on every render,
  // the way an unmemoized provider hands it out.
  const tappedFlashcard = () => ({
    loading: false,
    k1: tappedK1,
    callback: tappedCallback,
    resetFlashcard: jest.fn(),
    getAllStoredCards: mockGetAllStoredCards,
  });

  const lnurlResponse = (body: unknown) => ({json: async () => body});
  const statusResult = (status: string) => ({
    data: {lnInvoicePaymentStatus: {status, errors: []}},
  });
  const flush = () =>
    act(async () => {
      await new Promise(resolve => setImmediate(resolve));
    });

  beforeAll(() => {
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockUseFlashcard.mockImplementation(tappedFlashcard);
    mockUseSubscription.mockReturnValue({data: undefined, error: undefined});
    mockUseLazyQuery.mockReturnValue([
      jest.fn(() => Promise.resolve(statusResult('PENDING'))),
    ]);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('sends the callback once per k1 even when the context hands out a new resetFlashcard while the request is in flight', async () => {
    let resolveFetch!: (value: unknown) => void;
    fetchMock.mockReturnValue(
      new Promise(resolve => {
        resolveFetch = resolve;
      }),
    );

    const {rerenderInvoice, getByText} = renderInvoice();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(getByText('Loading')).toBeTruthy();

    // Each render gets a new resetFlashcard identity, so the focus effect
    // re-runs. The same k1 must not go out again.
    await act(async () => {
      rerenderInvoice();
    });
    await act(async () => {
      rerenderInvoice();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url.startsWith(tappedCallback)).toBe(true);
    expect(url).toContain(`k1=${tappedK1}`);
    expect(url).toContain('pr=lnbc1000n1ptest');

    await act(async () => {
      resolveFetch(lnurlResponse({status: 'OK'}));
    });
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('shows the paid state from the status query after the callback accepts, with no subscription event', async () => {
    jest.useFakeTimers(FAKE_TIMERS);
    const confirmStatus = jest
      .fn()
      .mockResolvedValueOnce(statusResult('PENDING'))
      .mockResolvedValue(statusResult('PAID'));
    mockUseLazyQuery.mockReturnValue([confirmStatus]);
    fetchMock.mockResolvedValue(lnurlResponse({status: 'OK'}));

    const {store, navigation} = renderInvoice();

    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The first status check follows the OK response immediately.
    expect(confirmStatus).toHaveBeenCalledTimes(1);
    expect(navigation.replace).not.toHaveBeenCalled();
    expect(store.getState().transactionHistory.transactions).toHaveLength(0);

    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
    await flush();

    expect(confirmStatus).toHaveBeenCalledTimes(2);
    expect(navigation.replace).toHaveBeenCalledWith('Success');
    expect(store.getState().transactionHistory.transactions).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stops asking after about 20 s without a paid confirmation', async () => {
    jest.useFakeTimers(FAKE_TIMERS);
    const confirmStatus = jest.fn(() =>
      Promise.resolve(statusResult('PENDING')),
    );
    mockUseLazyQuery.mockReturnValue([confirmStatus]);
    fetchMock.mockResolvedValue(lnurlResponse({status: 'OK'}));

    const {getByText, queryByText, navigation} = renderInvoice();

    await flush();
    expect(queryByText('Loading')).toBeTruthy();

    for (let second = 0; second < 25; second += 1) {
      await act(async () => {
        jest.advanceTimersByTime(1000);
      });
      await flush();
    }

    expect(confirmStatus).toHaveBeenCalledTimes(20);
    expect(navigation.replace).not.toHaveBeenCalled();
    expect(getByText('InvoiceQRCode')).toBeTruthy();
    // BTCPay already answered OK, so the card is debited: say so, or the
    // bare QR screen reads as "not paid" and invites a second tap.
    expect(toastShow).toHaveBeenCalledTimes(1);
    expect(toastShow).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'info',
        text1: 'Card charged. Waiting for payment confirmation.',
      }),
    );
  });

  it('stops polling as soon as the status query says the invoice expired', async () => {
    jest.useFakeTimers(FAKE_TIMERS);
    const confirmStatus = jest
      .fn()
      .mockResolvedValueOnce(statusResult('PENDING'))
      .mockResolvedValue(statusResult('EXPIRED'));
    mockUseLazyQuery.mockReturnValue([confirmStatus]);
    fetchMock.mockResolvedValue(lnurlResponse({status: 'OK'}));

    const {getByText, navigation} = renderInvoice();

    await flush();
    expect(confirmStatus).toHaveBeenCalledTimes(1);

    for (let second = 0; second < 25; second += 1) {
      await act(async () => {
        jest.advanceTimersByTime(1000);
      });
      await flush();
    }

    // One PENDING, one EXPIRED, then nothing: no remaining attempts burned.
    expect(confirmStatus).toHaveBeenCalledTimes(2);
    expect(getByText(invoiceUnavailableMessage)).toBeTruthy();
    expect(navigation.replace).not.toHaveBeenCalled();
    // The expired message is already on screen; no "card charged" toast.
    expect(toastShow).not.toHaveBeenCalled();
  });

  it('stops polling when the screen unmounts mid-poll', async () => {
    jest.useFakeTimers(FAKE_TIMERS);
    const confirmStatus = jest.fn(() =>
      Promise.resolve(statusResult('PENDING')),
    );
    mockUseLazyQuery.mockReturnValue([confirmStatus]);
    fetchMock.mockResolvedValue(lnurlResponse({status: 'OK'}));
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => {});

    try {
      const {unmount} = renderInvoice();

      await flush();
      await act(async () => {
        jest.advanceTimersByTime(1000);
      });
      await flush();
      expect(confirmStatus).toHaveBeenCalledTimes(2);

      unmount();

      await act(async () => {
        jest.advanceTimersByTime(5000);
      });
      await flush();

      expect(confirmStatus).toHaveBeenCalledTimes(2);
      // No setState on an unmounted component, no act() warning.
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  describe('card state after the callback', () => {
    const cardOnContext = () => ({
      ...tappedFlashcard(),
      tag: {id: 'tag-1'},
      lnurl: 'lnurl1cardreward',
      resetFlashcard: mockResetFlashcard,
    });
    const rewardsOn = {
      rewardRate: 0.02,
      minimumReward: 1,
      maximumReward: 1000,
      defaultReward: 21,
      merchantRewardId: 'pull-payment-1',
      isEnabled: true,
      showStandaloneRewards: false,
      loading: false,
      error: '',
      eventModeEnabled: false,
      eventActive: false,
      eventCustomerRewardCount: {},
    };

    const originalRewardsEnabled = process.env.REWARDS_ENABLED;

    beforeEach(() => {
      process.env.REWARDS_ENABLED = 'true';
      mockUseFlashcard.mockImplementation(cardOnContext);
    });

    afterEach(() => {
      if (originalRewardsEnabled === undefined) {
        delete process.env.REWARDS_ENABLED;
      } else {
        process.env.REWARDS_ENABLED = originalRewardsEnabled;
      }
    });

    // The context is cleared the moment BTCPay answers OK. consumedK1Ref is
    // per screen instance, so a k1 left on the context would be replayed by
    // the next Invoice screen whenever this one never reaches
    // handleSuccessfulPayment (poll gave up, invoice expired, Back). The
    // reward must still reach the card from what was snapshotted at OK.
    it('resets the card as soon as the callback answers OK and still sends the reward from the snapshot', async () => {
      jest.useFakeTimers(FAKE_TIMERS);
      const confirmStatus = jest
        .fn()
        .mockResolvedValueOnce(statusResult('PENDING'))
        .mockResolvedValue(statusResult('PAID'));
      mockUseLazyQuery.mockReturnValue([confirmStatus]);
      fetchMock.mockResolvedValue(lnurlResponse({status: 'OK'}));

      const {store, navigation, rerenderInvoice} = renderInvoice({
        reward: rewardsOn,
      });

      await flush();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(mockResetFlashcard).toHaveBeenCalledTimes(1);
      expect(navigation.replace).not.toHaveBeenCalled();

      // The provider has honoured the reset: nothing on the context now.
      mockUseFlashcard.mockImplementation(() => ({
        ...idleFlashcard(),
        tag: undefined,
        lnurl: undefined,
        k1: undefined,
        callback: undefined,
      }));
      await act(async () => {
        rerenderInvoice();
      });

      await act(async () => {
        jest.advanceTimersByTime(1000);
      });
      await flush();
      await flush();

      expect(mockAxiosPost).toHaveBeenCalledTimes(1);
      expect(mockAxiosPost).toHaveBeenCalledWith(
        expect.stringContaining('/pull-payments/pull-payment-1/payouts'),
        expect.objectContaining({destination: 'lnurl1cardreward'}),
      );
      const [transaction] = store.getState().transactionHistory.transactions;
      expect(transaction.reward).toEqual(
        expect.objectContaining({
          sentToCard: true,
          cardLnurl: 'lnurl1cardreward',
        }),
      );
      expect(navigation.replace).toHaveBeenCalledWith('Success');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      // Reset once at OK; the context was already empty when the sale closed.
      expect(mockResetFlashcard).toHaveBeenCalledTimes(1);
    });

    it('sends the reward from the snapshot when the subscription confirms paid after the poll gave up', async () => {
      jest.useFakeTimers(FAKE_TIMERS);
      const confirmStatus = jest.fn(() =>
        Promise.resolve(statusResult('PENDING')),
      );
      mockUseLazyQuery.mockReturnValue([confirmStatus]);
      fetchMock.mockResolvedValue(lnurlResponse({status: 'OK'}));

      const {store, navigation, rerenderInvoice} = renderInvoice({
        reward: rewardsOn,
      });

      await flush();
      expect(mockResetFlashcard).toHaveBeenCalledTimes(1);
      mockUseFlashcard.mockImplementation(() => ({
        ...idleFlashcard(),
        tag: undefined,
        lnurl: undefined,
        k1: undefined,
        callback: undefined,
      }));

      for (let second = 0; second < 25; second += 1) {
        await act(async () => {
          jest.advanceTimersByTime(1000);
        });
        await flush();
      }
      expect(confirmStatus).toHaveBeenCalledTimes(20);
      expect(navigation.replace).not.toHaveBeenCalled();
      expect(mockAxiosPost).not.toHaveBeenCalled();

      // The websocket comes back and reports PAID; the status query agrees.
      confirmStatus.mockImplementation(() =>
        Promise.resolve(statusResult('PAID')),
      );
      mockUseSubscription.mockReturnValue({
        data: paidSubscriptionData,
        error: undefined,
      });
      await act(async () => {
        rerenderInvoice();
      });
      await flush();
      await flush();

      expect(mockAxiosPost).toHaveBeenCalledTimes(1);
      expect(mockAxiosPost).toHaveBeenCalledWith(
        expect.stringContaining('/pull-payments/pull-payment-1/payouts'),
        expect.objectContaining({destination: 'lnurl1cardreward'}),
      );
      const [transaction] = store.getState().transactionHistory.transactions;
      expect(transaction.reward).toEqual(
        expect.objectContaining({
          sentToCard: true,
          cardLnurl: 'lnurl1cardreward',
        }),
      );
      expect(navigation.replace).toHaveBeenCalledWith('Success');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('looks the card up in storage by the snapshotted tag when it had no lnurl at OK', async () => {
      jest.useFakeTimers(FAKE_TIMERS);
      mockUseFlashcard.mockImplementation(() => ({
        ...cardOnContext(),
        lnurl: undefined,
      }));
      mockGetAllStoredCards.mockResolvedValueOnce([
        {tagId: 'tag-1', lnurl: 'lnurl1fromstorage'},
      ] as never);
      const confirmStatus = jest
        .fn()
        .mockResolvedValueOnce(statusResult('PENDING'))
        .mockResolvedValue(statusResult('PAID'));
      mockUseLazyQuery.mockReturnValue([confirmStatus]);
      fetchMock.mockResolvedValue(lnurlResponse({status: 'OK'}));

      const {store, rerenderInvoice} = renderInvoice({reward: rewardsOn});

      await flush();
      expect(mockResetFlashcard).toHaveBeenCalledTimes(1);
      mockUseFlashcard.mockImplementation(() => ({
        ...idleFlashcard(),
        tag: undefined,
        lnurl: undefined,
        k1: undefined,
        callback: undefined,
      }));
      await act(async () => {
        rerenderInvoice();
      });

      await act(async () => {
        jest.advanceTimersByTime(1000);
      });
      await flush();
      await flush();

      expect(mockAxiosPost).toHaveBeenCalledWith(
        expect.stringContaining('/pull-payments/pull-payment-1/payouts'),
        expect.objectContaining({destination: 'lnurl1fromstorage'}),
      );
      const [transaction] = store.getState().transactionHistory.transactions;
      expect(transaction.reward).toEqual(
        expect.objectContaining({
          sentToCard: true,
          cardLnurl: 'lnurl1fromstorage',
        }),
      );
    });

    it('resets the card when the callback answers ERROR', async () => {
      fetchMock.mockResolvedValue(
        lnurlResponse({status: 'ERROR', reason: 'nope'}),
      );

      const {getByText} = renderInvoice();

      await waitFor(() => expect(toastShow).toHaveBeenCalledTimes(1));
      await flush();

      expect(mockResetFlashcard).toHaveBeenCalledTimes(1);
      expect(mockAxiosPost).not.toHaveBeenCalled();
      expect(getByText('InvoiceQRCode')).toBeTruthy();
    });

    it('resets the card when the callback request fails', async () => {
      fetchMock.mockRejectedValue(new Error('network down'));

      const {getByText} = renderInvoice();

      await waitFor(() => expect(toastShow).toHaveBeenCalledTimes(1));
      await flush();

      expect(toastShow).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
          text1: 'Payment failed. Please try again.',
        }),
      );
      expect(mockResetFlashcard).toHaveBeenCalledTimes(1);
      expect(getByText('InvoiceQRCode')).toBeTruthy();
    });
  });

  it('shows the callback error once and never resends the same k1', async () => {
    fetchMock.mockResolvedValue(lnurlResponse({status: 'ERROR', reason: 'x'}));

    const {rerenderInvoice, getByText, navigation} = renderInvoice();

    await waitFor(() => expect(toastShow).toHaveBeenCalledTimes(1));
    expect(toastShow).toHaveBeenCalledWith(
      expect.objectContaining({type: 'error', text1: 'x'}),
    );

    // k1 is still set on the context (the mock never clears it); a re-run
    // of the focus effect must not retry.
    await act(async () => {
      rerenderInvoice();
    });
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(toastShow).toHaveBeenCalledTimes(1);
    expect(navigation.replace).not.toHaveBeenCalled();
    expect(getByText('InvoiceQRCode')).toBeTruthy();
  });

  it('sends a second tap with a different k1', async () => {
    fetchMock.mockResolvedValue(lnurlResponse({status: 'ERROR', reason: 'x'}));

    const {rerenderInvoice} = renderInvoice();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    mockUseFlashcard.mockImplementation(() => ({
      ...tappedFlashcard(),
      k1: 'second-tap',
    }));
    await act(async () => {
      rerenderInvoice();
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    expect(String(fetchMock.mock.calls[1][0])).toContain('k1=second-tap');
  });
});
