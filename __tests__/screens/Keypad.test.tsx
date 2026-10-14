import React from 'react';
import {Platform} from 'react-native';
import {fireEvent, render, waitFor} from '@testing-library/react-native';

import Keypad from '../../src/screens/Keypad';

const mockReadOnce = jest.fn();
const mockReader = {reading: false};
const mockNavigate = jest.fn();
const mockCreateInvoice = jest.fn();
const mockToastShow = jest.fn();
const mockDispatch = jest.fn();

jest.mock('@apollo/client', () => ({
  gql: (strings: TemplateStringsArray) => strings.join(''),
  useMutation: () => [mockCreateInvoice],
}));

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({navigate: mockNavigate}),
  useFocusEffect: (callback: () => void) => callback(),
}));

jest.mock('../../src/utils/toast', () => ({
  toastShow: (...args: unknown[]) => mockToastShow(...args),
}));

const USD = {id: 'USD', symbol: '$', fractionDigits: 2};
const defaultAmount = () => ({
  satAmount: '0',
  memo: '',
  displayAmount: '0',
  currency: USD as {id: string; symbol: string; fractionDigits: number},
  isPrimaryAmountSats: false,
});

const mockState = {
  user: {walletId: 'wallet'},
  amount: defaultAmount(),
};

// Prices the screen reads: USD per sat (useSatPrice), and the local-currency
// conversion (useRealtimePrice).
const defaultPrice = () => ({
  usdPerSat: 0.0005,
  refetchedUsdPerSat: 0,
  currencyToSats: (_amount: number): number => 0,
});
const mockPrice = defaultPrice();

jest.mock('../../src/store/hooks', () => ({
  useAppDispatch: () => mockDispatch,
  useAppSelector: (selector: (state: unknown) => unknown) =>
    selector(mockState),
}));

jest.mock('../../src/store/slices/rewardSlice', () => ({
  selectRewardConfig: () => ({isEnabled: false}),
  selectEventConfig: () => ({eventModeEnabled: false, eventActive: false}),
}));

jest.mock('../../src/utils/featureFlags', () => ({
  isRewardsEnabled: () => false,
}));

jest.mock('../../src/hooks', () => ({
  useActivityIndicator: () => ({toggleLoading: jest.fn()}),
  useSatPrice: () => ({
    satsToUsd: (sats: number) => sats * mockPrice.usdPerSat,
    refetchPrice: () => Promise.resolve(mockPrice.refetchedUsdPerSat),
  }),
  useRealtimePrice: () => ({
    currencyToSats: (amount: number) => ({
      convertedCurrencyAmount: mockPrice.currencyToSats(amount),
    }),
  }),
  useKeypadCardReader: () => ({
    readOnce: mockReadOnce,
    reading: mockReader.reading,
  }),
}));

jest.mock('../../src/components', () => {
  const MockReact = require('react');
  const {Text, TouchableOpacity} = require('react-native');

  return {
    Amount: () => MockReact.createElement(Text, null, 'Amount'),
    Note: () => MockReact.createElement(Text, null, 'Note'),
    NumPad: () => MockReact.createElement(Text, null, 'NumPad'),
    PrimaryButton: ({
      btnText,
      onPress,
    }: {
      btnText: string;
      onPress?: () => void;
    }) =>
      MockReact.createElement(
        TouchableOpacity,
        {onPress},
        MockReact.createElement(Text, null, btnText),
      ),
    SecondaryButton: ({btnText}: {btnText: string}) =>
      MockReact.createElement(Text, null, btnText),
    TextButton: ({
      title,
      disabled,
      onPress,
    }: {
      title: string;
      disabled?: boolean;
      onPress: () => void;
    }) =>
      MockReact.createElement(
        TouchableOpacity,
        {onPress, disabled, accessibilityState: {disabled: !!disabled}},
        MockReact.createElement(Text, null, title),
      ),
  };
});

let platform: {restore: () => void} | undefined;
const setPlatform = (os: 'android' | 'ios') => {
  platform = jest.replaceProperty(Platform, 'OS', os);
};

beforeEach(() => {
  jest.clearAllMocks();
  mockReader.reading = false;
  mockState.amount = defaultAmount();
  Object.assign(mockPrice, defaultPrice());
});

afterEach(() => {
  platform?.restore();
  platform = undefined;
});

describe('Keypad card balance control', () => {
  it('on iOS, offers a "Card balance" control that starts a one-shot read', () => {
    setPlatform('ios');
    const {getByText} = render(<Keypad />);

    fireEvent.press(getByText('Card balance'));

    expect(mockReadOnce).toHaveBeenCalledTimes(1);
  });

  it('on iOS, disables the control while a read is in flight', () => {
    setPlatform('ios');
    mockReader.reading = true;
    const {getByText} = render(<Keypad />);

    // A disabled touchable swallows the press (RNTL honours
    // accessibilityState.disabled), so a second read cannot start.
    fireEvent.press(getByText('Card balance'));

    expect(mockReadOnce).not.toHaveBeenCalled();
  });

  it('on Android, renders no extra control — the reader is armed while focused', () => {
    setPlatform('android');
    const {queryByText, getByText} = render(<Keypad />);

    expect(queryByText('Card balance')).toBeNull();
    expect(getByText('Next')).toBeTruthy();
  });
});

describe('Keypad Next: offline goes to the card charge (ENG-703)', () => {
  const CARD_ONLY = "Can't reach Flash: card payments only";
  const PRICE_LOADING =
    'Bitcoin price is still loading. Please try again in a moment.';
  const OFFLINE = {
    networkError: new TypeError('Network request failed'),
    graphQLErrors: [],
  };

  const enterSats = (sats: string) => {
    mockState.amount = {
      ...defaultAmount(),
      satAmount: sats,
      displayAmount: sats,
      currency: {id: 'SAT', symbol: '', fractionDigits: 0},
    };
    // SAT is its own unit: one "local" unit is one sat.
    mockPrice.currencyToSats = amount => amount;
  };

  const enterFiat = (display: string, currency = USD, usdPerLocalUnit = 1) => {
    // Fiat typing updates displayAmount only; satAmount stays 0.
    mockState.amount = {...defaultAmount(), displayAmount: display, currency};
    mockPrice.currencyToSats = amount =>
      (amount * usdPerLocalUnit) / mockPrice.usdPerSat;
  };

  const pressNext = () => {
    const screen = render(<Keypad />);
    fireEvent.press(screen.getByText('Next'));
    return screen;
  };

  const toastMessages = () =>
    mockToastShow.mock.calls.map(([arg]) => (arg as {message: string}).message);

  let consoleError: jest.SpyInstance;
  beforeEach(() => {
    // The screen logs every invoice failure; keep the test output readable.
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => consoleError.mockRestore());

  it('SAT above a cent, invoice request cannot reach the API: charges the card', async () => {
    enterSats('65');
    mockPrice.usdPerSat = 1e-3; // 65 sats = 6.5 cents
    mockCreateInvoice.mockRejectedValue(OFFLINE);

    pressNext();

    await waitFor(() =>
      expect(mockNavigate).toHaveBeenCalledWith('CashuCardCharge'),
    );
    expect(mockToastShow).toHaveBeenCalledWith({
      message: CARD_ONLY,
      type: 'info',
    });
    expect(toastMessages()).toEqual([CARD_ONLY]);
    expect(mockDispatch).toHaveBeenCalledWith({
      type: 'amount/setSatAmount',
      payload: '65',
    });
  });

  it('USD with a cached price, invoice request cannot reach the API: charges the card for the converted sats', async () => {
    enterFiat('0.65'); // $0.65 at $0.0005/sat = 1,300 sats
    mockCreateInvoice.mockRejectedValue(OFFLINE);

    pressNext();

    await waitFor(() =>
      expect(mockNavigate).toHaveBeenCalledWith('CashuCardCharge'),
    );
    expect(mockDispatch).toHaveBeenCalledWith({
      type: 'amount/setSatAmount',
      payload: '1300',
    });
    expect(toastMessages()).toEqual([CARD_ONLY]);
  });

  it('a server error (5xx) also charges the card', async () => {
    enterFiat('0.65');
    mockCreateInvoice.mockRejectedValue({networkError: {statusCode: 503}});

    pressNext();

    await waitFor(() =>
      expect(mockNavigate).toHaveBeenCalledWith('CashuCardCharge'),
    );
    expect(toastMessages()).toEqual([CARD_ONLY]);
  });

  it('a 4xx is a real answer: keeps the invoice error and never offers the card', async () => {
    enterFiat('0.65');
    mockCreateInvoice.mockRejectedValue({networkError: {statusCode: 401}});

    pressNext();

    await waitFor(() => expect(mockToastShow).toHaveBeenCalled());
    expect(mockToastShow).toHaveBeenCalledWith({
      message: 'Unable to create invoice. Please try again.',
      type: 'error',
    });
    expect(mockNavigate).not.toHaveBeenCalledWith('CashuCardCharge');
  });

  it('a GraphQL business error keeps its toast and never offers the card', async () => {
    enterFiat('0.65');
    mockCreateInvoice.mockResolvedValue({
      data: {
        lnUsdInvoiceCreateOnBehalfOfRecipient: {
          invoice: null,
          errors: [{message: 'Recipient wallet not found'}],
        },
      },
    });

    pressNext();

    await waitFor(() => expect(mockToastShow).toHaveBeenCalled());
    expect(toastMessages()).toEqual(['Recipient wallet not found']);
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('too large: refuses before any invoice request and never offers the card', async () => {
    enterFiat('20000');

    pressNext();

    await waitFor(() => expect(mockToastShow).toHaveBeenCalled());
    expect(toastMessages()).toEqual([
      'Amount too large. Maximum allowed is $10,000 (US$10,000 equivalent)',
    ]);
    expect(mockCreateInvoice).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('online: sends the invoice request once (no retries) and shows the invoice', async () => {
    enterFiat('0.65');
    mockCreateInvoice.mockResolvedValue({
      data: {
        lnUsdInvoiceCreateOnBehalfOfRecipient: {
          invoice: {paymentRequest: 'lnbc1'},
          errors: [],
        },
      },
    });

    pressNext();

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('Invoice'));
    expect(mockCreateInvoice).toHaveBeenCalledTimes(1);
    expect(mockCreateInvoice).toHaveBeenCalledWith(
      expect.objectContaining({
        variables: {
          input: expect.objectContaining({
            recipientWalletId: 'wallet',
            amount: 65,
          }),
        },
        context: {noRetry: true},
      }),
    );
    expect(mockToastShow).not.toHaveBeenCalled();
  });

  it('SAT with no price at all (refetch cannot reach the API): charges the card and says why', async () => {
    enterSats('65');
    mockPrice.usdPerSat = 0;
    mockPrice.refetchedUsdPerSat = 0;

    pressNext();

    await waitFor(() =>
      expect(mockNavigate).toHaveBeenCalledWith('CashuCardCharge'),
    );
    expect(mockToastShow).toHaveBeenCalledWith({
      message: CARD_ONLY,
      type: 'info',
    });
    expect(mockCreateInvoice).not.toHaveBeenCalled();
  });

  it('SAT below a cent with a price: charges the card without a toast', async () => {
    enterSats('7');
    mockPrice.usdPerSat = 1e-3; // 7 sats = 0.7 cents

    pressNext();

    await waitFor(() =>
      expect(mockNavigate).toHaveBeenCalledWith('CashuCardCharge'),
    );
    expect(mockToastShow).not.toHaveBeenCalled();
    expect(mockCreateInvoice).not.toHaveBeenCalled();
  });

  it('USD with no BTC price: the price-loading message, no card, no invoice', async () => {
    enterFiat('0.65');
    mockPrice.usdPerSat = 0;
    mockPrice.refetchedUsdPerSat = 0;
    mockPrice.currencyToSats = amount => amount * 2000;

    pressNext();

    await waitFor(() => expect(mockToastShow).toHaveBeenCalled());
    expect(toastMessages()).toEqual([PRICE_LOADING]);
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(mockCreateInvoice).not.toHaveBeenCalled();
  });

  it('JMD with no local price (conversion is NaN): the price-loading message, never NaN sats', async () => {
    enterFiat('100', {id: 'JMD', symbol: 'J$', fractionDigits: 2});
    mockPrice.currencyToSats = () => NaN;

    pressNext();

    await waitFor(() => expect(mockToastShow).toHaveBeenCalled());
    expect(toastMessages()).toEqual([PRICE_LOADING]);
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(mockCreateInvoice).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({type: 'amount/setSatAmount'}),
    );
  });
});
