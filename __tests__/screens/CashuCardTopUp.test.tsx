import React from 'react';
import {AppState} from 'react-native';
import {act, fireEvent, render} from '@testing-library/react-native';

import CashuCardTopUp, {
  invoiceQrText,
  PIN_COMMIT_MS,
  timeLeft,
  TOPUP_POLL_MS,
} from '../../src/screens/CashuCardTopUp';
import type {CardSummary} from '../../src/services/cashuCard';
import type {TopUpEntry} from '../../src/services/cashuTopUp';

jest.mock('react-native-svg', () => require('../../__mocks__/svgStub'));

jest.mock('react-native-qrcode-svg', () => {
  const MockReact = require('react');
  const {Text} = require('react-native');
  return ({value}: {value: string}) =>
    MockReact.createElement(Text, {testID: 'qr-value'}, value);
});

jest.mock('../../src/hooks', () => ({
  useRealtimePrice: () => ({
    satsToCurrency: (sats: number) => ({
      formattedCurrency: `$${(sats / 1000).toFixed(2)}`,
    }),
    loading: false,
  }),
}));

const mockStartTopUp = jest.fn();
const mockPollTopUp = jest.fn();
const mockLoadTopUp = jest.fn();
const mockGetTopUp = jest.fn();
jest.mock('../../src/services/cashuTopUp', () => ({
  ...jest.requireActual('../../src/services/cashuTopUp'),
  startTopUp: (...a: unknown[]) => mockStartTopUp(...a),
  pollTopUp: (...a: unknown[]) => mockPollTopUp(...a),
  loadTopUp: (...a: unknown[]) => mockLoadTopUp(...a),
  getTopUp: (...a: unknown[]) => mockGetTopUp(...a),
}));

class MockUserCancel extends Error {}
const mockTransceive = jest.fn();
const mockWithCardSession = jest.fn();
const mockCancelCardSession = jest.fn();
jest.mock('../../src/services/cashuCardNfc', () => ({
  withCardSession: (...a: unknown[]) => mockWithCardSession(...a),
  isUserCancel: (e: unknown) => e instanceof MockUserCancel,
  cancelCardSession: () => mockCancelCardSession(),
}));

const {TopUpError} = jest.requireActual('../../src/services/cashuTopUp');

const FAKE_TIMERS: Parameters<typeof jest.useFakeTimers>[0] = {
  doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'],
};

const SUMMARY: CardSummary = {
  appletVersion: '2.1',
  info: {
    version: '2.1',
    major: 2,
    minor: 1,
    maxSlots: 128,
    unspent: 1,
    spent: 0,
    empty: 127,
    capabilities: 0xff,
    secp256k1Native: true,
    schnorr: true,
    pinState: 'unset',
    format: 4,
    triesLeft: 3,
    locked: false,
    recordSet: true,
    dailyLimit: 0,
    hasOwner: true,
    now: 0,
    windowStart: 0,
    spentToday: 0,
    changeGrant: false,
  },
  pubkey: '02' + 'ab'.repeat(32),
  balance: 8,
};
const PIN_CARD: CardSummary = {
  ...SUMMARY,
  info: {...SUMMARY.info, pinState: 'set'},
};
const MINT = 'https://card.mint';

const entry = (over: Partial<TopUpEntry> = {}): TopUpEntry => ({
  topupId: 'quote-0123456789',
  cardPubkey: SUMMARY.pubkey,
  mintUrl: MINT,
  bolt11: 'lnbc50n1abc',
  amountSat: 5,
  pieces: [4, 1],
  expiry: Math.floor(Date.now() / 1000) + 600,
  state: 'waiting',
  attempts: 0,
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

const listeners: Record<string, ((e: {preventDefault: () => void}) => void)[]> =
  {};
const nav = {
  goBack: jest.fn(),
  reset: jest.fn(),
  getState: () => ({routes: [{name: 'Home', key: 'home'}]}),
  addListener: jest.fn((type: string, cb: never) => {
    (listeners[type] ??= []).push(cb);
    return () => {
      listeners[type] = listeners[type].filter(l => l !== cb);
    };
  }),
};

const renderScreen = (params: Partial<RootStackType['CashuCardTopUp']> = {}) =>
  render(
    <CashuCardTopUp
      navigation={nav as never}
      route={{
        key: 'k',
        name: 'CashuCardTopUp',
        params: {summary: SUMMARY, cardMint: MINT, cardUnit: 0, ...params},
      }}
    />,
  );

const flush = () => act(async () => {});
const tick = (ms: number) =>
  act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });

const type = (getByTestId: (id: string) => unknown, digits: string) => {
  for (const d of digits) {
    fireEvent.press(getByTestId(`pin-key-${d}`) as never);
  }
};

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of Object.keys(listeners)) {
    delete listeners[k];
  }
  mockPollTopUp.mockImplementation(async () => entry());
  mockWithCardSession.mockImplementation(async (fn: (t: unknown) => unknown) =>
    fn(mockTransceive),
  );
  Object.defineProperty(AppState, 'currentState', {
    value: 'active',
    configurable: true,
  });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('helpers', () => {
  it('draws the invoice as LIGHTNING: and upper case', () => {
    expect(invoiceQrText('lnbc50n1abc')).toBe('LIGHTNING:LNBC50N1ABC');
  });

  it('counts down m:ss to the expiry, 0:00 past it', () => {
    expect(timeLeft(1000, 1000_000 - 125_000)).toBe('2:05');
    expect(timeLeft(1000, 2000_000)).toBe('0:00');
  });
});

describe('CashuCardTopUp', () => {
  it('rounds the typed amount and shows its fiat, Create invoice enabled only for some sats', async () => {
    const {getByTestId} = renderScreen();
    expect(getByTestId('topup-create').props.accessibilityState).toEqual({
      disabled: true,
    });
    type(getByTestId, '1000');
    expect(getByTestId('topup-amount').props.children).toBe('Top up 1024 sats');
    expect(getByTestId('topup-fiat').props.children).toBe('$1.02');
    expect(getByTestId('topup-rounding').props.children).toBe(
      'Rounded from 1000 sats to fit the card',
    );
    expect(
      getByTestId('topup-create').props.accessibilityState?.disabled,
    ).toBeFalsy();
  });

  it('refuses more than 100,000 sats before any quote', () => {
    const {getByTestId} = renderScreen();
    type(getByTestId, '100001');
    expect(getByTestId('topup-rounding').props.children).toBe(
      'A top-up is at most 100,000 sats.',
    );
    fireEvent.press(getByTestId('topup-create'));
    expect(mockStartTopUp).not.toHaveBeenCalled();
  });

  it("quotes the rounded amount at the card's mint and draws the invoice", async () => {
    mockStartTopUp.mockResolvedValue(entry());
    const {getByTestId, getByText} = renderScreen();
    type(getByTestId, '5');
    fireEvent.press(getByTestId('topup-create'));
    await flush();

    expect(mockStartTopUp).toHaveBeenCalledWith({
      summary: SUMMARY,
      cardMint: MINT,
      unit: 0,
      sat: 5,
    });
    expect(getByTestId('qr-value').props.children).toBe(
      'LIGHTNING:LNBC50N1ABC',
    );
    expect(getByText('Scan with a Lightning wallet')).toBeTruthy();
    expect(getByTestId('topup-expires').props.children).toMatch(
      /^Expires in (10:00|9:59)$/,
    );
  });

  it('says why a quote was refused', async () => {
    mockStartTopUp.mockRejectedValue(new TopUpError('card_full'));
    const {getByTestId} = renderScreen();
    type(getByTestId, '7');
    fireEvent.press(getByTestId('topup-create'));
    await flush();

    expect(getByTestId('topup-error-title').props.children).toBe(
      'This card is full',
    );
    expect(getByTestId('topup-error-body').props.children).toBe(
      'Spend from it first, then top up.',
    );
  });

  it('polls the mint every 1.5 s and moves to the card tap once paid', async () => {
    jest.useFakeTimers(FAKE_TIMERS);
    mockStartTopUp.mockResolvedValue(entry());
    mockPollTopUp
      .mockResolvedValueOnce(entry())
      .mockResolvedValueOnce(entry({state: 'paid'}));
    const {getByTestId} = renderScreen();
    type(getByTestId, '5');
    fireEvent.press(getByTestId('topup-create'));
    await flush();

    await tick(TOPUP_POLL_MS);
    expect(mockPollTopUp).toHaveBeenCalledTimes(1);
    await tick(TOPUP_POLL_MS);
    expect(mockPollTopUp).toHaveBeenCalledTimes(2);
    expect(getByTestId('topup-paid').props.children).toBe(
      'Hold the card to load 5 sats',
    );
  });

  it('does not poll in the background, and checks at once on coming back', async () => {
    jest.useFakeTimers(FAKE_TIMERS);
    const handlers: ((s: string) => void)[] = [];
    const spy = jest
      .spyOn(AppState, 'addEventListener')
      .mockImplementation((_t, h) => {
        handlers.push(h as never);
        return {remove: jest.fn()} as never;
      });
    mockStartTopUp.mockResolvedValue(entry());
    const {getByTestId} = renderScreen();
    type(getByTestId, '5');
    fireEvent.press(getByTestId('topup-create'));
    await flush();

    Object.defineProperty(AppState, 'currentState', {
      value: 'background',
      configurable: true,
    });
    await tick(TOPUP_POLL_MS * 3);
    expect(mockPollTopUp).not.toHaveBeenCalled();

    Object.defineProperty(AppState, 'currentState', {
      value: 'active',
      configurable: true,
    });
    mockPollTopUp.mockResolvedValueOnce(entry({state: 'paid'}));
    await act(async () => {
      handlers.forEach(h => h('active'));
    });
    expect(mockPollTopUp).toHaveBeenCalledTimes(1);
    expect(getByTestId('topup-paid')).toBeTruthy();
    spy.mockRestore();
  });

  it('an expired invoice says so, and New invoice makes a new quote', async () => {
    jest.useFakeTimers(FAKE_TIMERS);
    mockStartTopUp
      .mockResolvedValueOnce(entry())
      .mockResolvedValueOnce(entry({topupId: 'quote-second'}));
    mockPollTopUp.mockResolvedValueOnce(entry({state: 'expired'}));
    const {getByTestId} = renderScreen();
    type(getByTestId, '5');
    fireEvent.press(getByTestId('topup-create'));
    await flush();
    await tick(TOPUP_POLL_MS);

    expect(getByTestId('topup-error-title').props.children).toBe(
      'The invoice expired',
    );
    expect(getByTestId('topup-retry')).toBeTruthy();
    fireEvent.press(getByTestId('topup-retry'));
    await flush();
    expect(mockStartTopUp).toHaveBeenCalledTimes(2);
    expect(getByTestId('qr-value')).toBeTruthy();
  });

  it('Cancel on the invoice only goes back: the top-up stays on record', async () => {
    mockStartTopUp.mockResolvedValue(entry());
    const {getByTestId} = renderScreen();
    type(getByTestId, '5');
    fireEvent.press(getByTestId('topup-create'));
    await flush();
    fireEvent.press(getByTestId('topup-cancel'));
    expect(nav.goBack).toHaveBeenCalledTimes(1);
  });

  it('loads a paid top-up onto a card with no PIN, then shows the load id', async () => {
    mockGetTopUp.mockResolvedValue(entry({state: 'paid'}));
    mockLoadTopUp.mockResolvedValue({amountSat: 5, loadId: 'quote-01'});
    const {getByTestId} = renderScreen({resume: 'quote-0123456789'});
    await flush();

    fireEvent.press(getByTestId('topup-load'));
    await flush();

    expect(mockWithCardSession).toHaveBeenCalledWith(expect.any(Function), {
      alertMessage: 'Hold the card to load 5 sats',
    });
    expect(mockLoadTopUp).toHaveBeenCalledWith({
      topupId: 'quote-0123456789',
      transceive: mockTransceive,
      pin: undefined,
      onPhase: expect.any(Function),
    });
    expect(getByTestId('topup-loaded').props.children).toBe('Loaded 5 sats');
    expect(getByTestId('topup-load-id').props.children).toBe(
      'Load id quote-01',
    );
    fireEvent.press(getByTestId('topup-done'));
    expect(nav.reset).toHaveBeenCalledWith({
      index: 0,
      routes: [{name: 'Home', key: 'home'}],
    });
  });

  it('asks a PIN card for its PIN first, and sends it with the load', async () => {
    jest.useFakeTimers(FAKE_TIMERS);
    mockGetTopUp.mockResolvedValue(entry({state: 'paid'}));
    mockLoadTopUp.mockResolvedValue({amountSat: 5, loadId: 'quote-01'});
    const {getByTestId} = renderScreen({
      summary: PIN_CARD,
      resume: 'quote-0123456789',
    });
    await flush();

    fireEvent.press(getByTestId('topup-load'));
    expect(getByTestId('pin-sheet')).toBeTruthy();
    expect(mockLoadTopUp).not.toHaveBeenCalled();
    type(getByTestId, '1234');
    await tick(PIN_COMMIT_MS);

    expect(mockLoadTopUp).toHaveBeenCalledWith(
      expect.objectContaining({pin: '1234'}),
    );
    expect(getByTestId('topup-loaded')).toBeTruthy();
  });

  it('an iOS sheet cancel is "Not loaded yet", and Tap card again goes back to the paid step', async () => {
    mockGetTopUp.mockResolvedValue(entry({state: 'paid'}));
    mockWithCardSession.mockRejectedValueOnce(new MockUserCancel());
    const {getByTestId} = renderScreen({resume: 'quote-0123456789'});
    await flush();

    fireEvent.press(getByTestId('topup-load'));
    await flush();
    expect(getByTestId('topup-error-title').props.children).toBe(
      'Not loaded yet',
    );
    expect(getByTestId('topup-error-body').props.children).toBe(
      'The top-up is paid and waiting. Tap the card to load it.',
    );
    fireEvent.press(getByTestId('topup-retry'));
    expect(getByTestId('topup-paid')).toBeTruthy();
  });

  it('a full card after payment says the top-up is paid and waiting', async () => {
    mockGetTopUp.mockResolvedValue(entry({state: 'loading'}));
    mockLoadTopUp.mockRejectedValueOnce(new TopUpError('card_full'));
    const {getByTestId} = renderScreen({resume: 'quote-0123456789'});
    await flush();
    fireEvent.press(getByTestId('topup-load'));
    await flush();
    expect(getByTestId('topup-error-body').props.children).toBe(
      'Spend from it, then tap again. The top-up is paid and waiting.',
    );
  });

  it('resumes an unpaid top-up at its invoice', async () => {
    mockGetTopUp.mockResolvedValue(entry());
    const {getByTestId} = renderScreen({resume: 'quote-0123456789'});
    await flush();
    expect(getByTestId('qr-value')).toBeTruthy();
  });

  it('holds navigation while the card is loading, and lets it go after', async () => {
    mockGetTopUp.mockResolvedValue(entry({state: 'paid'}));
    let finish!: (v: unknown) => void;
    mockLoadTopUp.mockImplementation(
      ({onPhase}: {onPhase: (p: string) => void}) => {
        onPhase('reading');
        return new Promise(resolve => (finish = resolve));
      },
    );
    const {getByTestId} = renderScreen({resume: 'quote-0123456789'});
    await flush();
    fireEvent.press(getByTestId('topup-load'));
    await flush();
    expect(getByTestId('topup-loading').props.children).toBe(
      'Loading… keep the card on the phone',
    );

    const held = {preventDefault: jest.fn()};
    listeners.beforeRemove.forEach(l => l(held));
    expect(held.preventDefault).toHaveBeenCalled();
    expect(mockCancelCardSession).not.toHaveBeenCalled();

    await act(async () => finish({amountSat: 5, loadId: 'quote-01'}));
    const free = {preventDefault: jest.fn()};
    listeners.beforeRemove.forEach(l => l(free));
    expect(free.preventDefault).not.toHaveBeenCalled();
    expect(mockCancelCardSession).toHaveBeenCalled();
  });

  it('waits for the card with a Cancel, and holds nothing until it answers', async () => {
    mockGetTopUp.mockResolvedValue(entry({state: 'paid'}));
    let cancel!: (e: unknown) => void;
    mockWithCardSession.mockImplementationOnce(
      () => new Promise((_, reject) => (cancel = reject)),
    );
    mockCancelCardSession.mockImplementation(() =>
      cancel(new MockUserCancel()),
    );
    const {getByTestId} = renderScreen({resume: 'quote-0123456789'});
    await flush();
    fireEvent.press(getByTestId('topup-load'));
    await flush();
    expect(getByTestId('topup-tap').props.children).toBe(
      'Hold the card to the phone to load 5 sats',
    );

    const free = {preventDefault: jest.fn()};
    listeners.beforeRemove.forEach(l => l(free));
    expect(free.preventDefault).not.toHaveBeenCalled();

    mockCancelCardSession.mockClear();
    fireEvent.press(getByTestId('topup-tap-cancel'));
    await flush();
    expect(mockCancelCardSession).toHaveBeenCalled();
    expect(getByTestId('topup-error-title').props.children).toBe(
      'Not loaded yet',
    );
  });
});
