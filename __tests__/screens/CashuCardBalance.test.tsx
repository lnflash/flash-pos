import React from 'react';
import {StyleSheet} from 'react-native';
import {act, fireEvent, render} from '@testing-library/react-native';

import CashuCardBalance from '../../src/screens/CashuCardBalance';
import type {CardSummary} from '../../src/services/cashuCard';

jest.mock('react-native-svg', () => require('../../__mocks__/svgStub'));

const mockGoBack = jest.fn();
const mockReplace = jest.fn();
const mockRefreshWaiting = jest.fn();
const mockOwedPieces = jest.fn();

jest.mock('../../src/services/cashuTopUp', () => ({
  ...jest.requireActual('../../src/services/cashuTopUp'),
  refreshWaitingTopUps: (...args: unknown[]) => mockRefreshWaiting(...args),
  owedPiecesFor: (...args: unknown[]) => mockOwedPieces(...args),
}));
const mockSatsToCurrency = jest.fn();
const mockPrice = {loading: false};

jest.mock('../../src/hooks', () => ({
  useRealtimePrice: () => ({
    satsToCurrency: (sats: number) => mockSatsToCurrency(sats),
    loading: mockPrice.loading,
  }),
}));

const SUMMARY: CardSummary = {
  appletVersion: '1.2',
  info: {
    version: '1.2',
    maxSlots: 32,
    unspent: 3,
    spent: 1,
    empty: 28,
    secp256k1Native: true,
    schnorr: true,
    pinState: 'set',
    // Protocol 2.0's GET_INFO fields: what this screen does not show.
    major: 1,
    minor: 2,
    capabilities: 0xff,
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
  pubkey: '02c0ffee' + 'ab'.repeat(29),
  balance: 500,
};

const renderScreen = (
  summary: CardSummary = SUMMARY,
  extra: Partial<RootStackType['CashuCardBalance']> = {},
) =>
  render(
    <CashuCardBalance
      navigation={{goBack: mockGoBack, replace: mockReplace} as never}
      route={{
        key: 'k',
        name: 'CashuCardBalance',
        params: {summary, ...extra},
      }}
    />,
  );

beforeEach(() => {
  jest.clearAllMocks();
  mockPrice.loading = false;
  mockRefreshWaiting.mockResolvedValue([]);
  mockOwedPieces.mockResolvedValue(0);
  mockSatsToCurrency.mockImplementation((sats: number) => ({
    convertedCurrencyAmount: sats / 1000,
    formattedCurrency: `$${(sats / 1000).toFixed(2)}`,
  }));
});

describe('CashuCardBalance', () => {
  it('shows the balance the card reported, in sats, with its fiat equivalent', () => {
    const {getByText} = renderScreen();

    expect(getByText('500 sats')).toBeTruthy();
    expect(mockSatsToCurrency).toHaveBeenCalledWith(500);
    expect(getByText('$0.50')).toBeTruthy();
  });

  it('draws the Flash Card art once', () => {
    const svg = require('../../__mocks__/svgStub');
    svg.__resetSvgRenders();

    renderScreen();

    expect(svg.__svgRenders['0 0 320 202']).toBe(1);
  });

  it('shows the card id, applet, slots and PIN state', () => {
    const {getByText} = renderScreen();

    expect(getByText('02c0ffee')).toBeTruthy();
    expect(getByText('1.2')).toBeTruthy();
    expect(getByText('3 unspent · 1 spent · 28 free of 32')).toBeTruthy();
    expect(getByText('Set')).toBeTruthy();
  });

  it('explains spent slots when the card has any', () => {
    const {getByText} = renderScreen();

    expect(
      getByText(
        "Spent slots are freed by the holder's Flash app once settled.",
      ),
    ).toBeTruthy();
  });

  it('shows a zero spent count without the spent-slot caption', () => {
    const {getByText, queryByText} = renderScreen({
      ...SUMMARY,
      info: {...SUMMARY.info, spent: 0, empty: 29},
    });

    expect(getByText('3 unspent · 0 spent · 29 free of 32')).toBeTruthy();
    expect(queryByText(/Spent slots are freed/)).toBeNull();
  });

  it('counts a full card with no free slots', () => {
    const {getByText} = renderScreen({
      ...SUMMARY,
      info: {...SUMMARY.info, unspent: 14, spent: 18, empty: 0},
    });

    expect(getByText('14 unspent · 18 spent · 0 free of 32')).toBeTruthy();
  });

  it('lets a long slot count wrap under the right edge instead of overflowing', () => {
    // Yoga's default flex-shrink is 0: without it, the full-card string runs
    // past the Details box on a 375pt phone rather than wrapping.
    const {getByText} = renderScreen({
      ...SUMMARY,
      info: {...SUMMARY.info, unspent: 14, spent: 18, empty: 0},
    });

    const style = StyleSheet.flatten(
      getByText('14 unspent · 18 spent · 0 free of 32').props.style,
    );
    expect(style).toMatchObject({flexShrink: 1, textAlign: 'right'});
  });

  it.each([
    ['unset', 'Not set'],
    ['blocked', 'Blocked'],
    ['unknown', 'Unknown'],
  ] as const)('labels pinState %s as "%s"', (pinState, label) => {
    const {getByText} = renderScreen({
      ...SUMMARY,
      info: {...SUMMARY.info, pinState},
    });

    expect(getByText(label)).toBeTruthy();
  });

  it('holds the fiat line while the price is still loading, sats shown regardless', () => {
    mockPrice.loading = true;
    const {getByText, queryByText} = renderScreen();

    expect(getByText('500 sats')).toBeTruthy();
    expect(queryByText('$0.50')).toBeNull();
  });

  it('says nothing about change when none is owed', () => {
    const {queryByText} = renderScreen();

    expect(queryByText(/^Change /)).toBeNull();
  });

  it('shows change waiting for a PIN card, to be added on the next charge (ENG-630)', () => {
    const {getByText} = renderScreen(SUMMARY, {owedChangeSat: 6});

    expect(
      getByText('Change waiting · 6 sats — added on the next charge'),
    ).toBeTruthy();
  });

  it('shows change the keypad read just added to a PIN-less card (ENG-630)', () => {
    const {getByText, queryByText} = renderScreen(
      {...SUMMARY, info: {...SUMMARY.info, pinState: 'unset'}},
      {changeAddedSat: 1},
    );

    expect(getByText('Change added · 1 sat')).toBeTruthy();
    expect(queryByText(/Change waiting/)).toBeNull();
  });

  it('shows both what the keypad read added and what is still waiting when the write stopped short (ENG-630)', () => {
    const {getByText} = renderScreen(
      {...SUMMARY, info: {...SUMMARY.info, pinState: 'unset'}},
      {changeAddedSat: 4, owedChangeSat: 2},
    );

    expect(getByText('Change added · 4 sats')).toBeTruthy();
    expect(
      getByText('Change waiting · 2 sats — added on the next charge'),
    ).toBeTruthy();
  });

  it('tags the balance and each change note for the simulator e2e flows (ENG-634)', () => {
    const {getByTestId, queryByTestId} = renderScreen(
      {...SUMMARY, balance: 16, info: {...SUMMARY.info, pinState: 'unset'}},
      {changeAddedSat: 4, owedChangeSat: 2},
    );

    expect(getByTestId('balance-sat').props.children).toEqual([16, ' sats']);
    expect(getByTestId('balance-added').props.children).toBe(
      'Change added · 4 sats',
    );
    expect(getByTestId('balance-owed').props.children).toBe(
      'Change waiting · 2 sats — added on the next charge',
    );

    const none = renderScreen();
    expect(none.queryByTestId('balance-owed')).toBeNull();
    expect(none.queryByTestId('balance-added')).toBeNull();
    expect(queryByTestId('balance-sat')).not.toBeNull();
  });

  it('"Charge this card" goes back to the keypad', () => {
    const {getByText} = renderScreen();

    fireEvent.press(getByText('Charge this card'));

    expect(mockGoBack).toHaveBeenCalledTimes(1);
  });

  describe('top up (ENG-853)', () => {
    const MINT = 'https://card.mint';
    const flush = () => act(async () => {});

    it('offers both: Charge this card goes back, Top up card opens the top-up at the card mint', async () => {
      const {getByTestId, getByText} = renderScreen(SUMMARY, {
        cardMint: MINT,
        cardUnit: 0,
      });
      await flush();

      expect(getByText('Charge this card')).toBeTruthy();
      fireEvent.press(getByTestId('balance-charge'));
      expect(mockGoBack).toHaveBeenCalledTimes(1);

      fireEvent.press(getByTestId('balance-topup'));
      expect(mockReplace).toHaveBeenCalledWith('CashuCardTopUp', {
        summary: SUMMARY,
        cardMint: MINT,
        cardUnit: 0,
      });
      expect(mockRefreshWaiting).toHaveBeenCalledWith(SUMMARY.pubkey);
    });

    it("is disabled, with a caption, when the card's mint was not read", async () => {
      const {getByTestId} = renderScreen(SUMMARY);
      await flush();

      expect(getByTestId('balance-topup').props.accessibilityState).toEqual({
        disabled: true,
      });
      expect(getByTestId('balance-topup-refusal').props.children).toBe(
        "Can't read the card's mint",
      );
      fireEvent.press(getByTestId('balance-topup'));
      expect(mockReplace).not.toHaveBeenCalled();
    });

    it.each([
      ['a locked card', {locked: true}, 'This card is locked'],
      ['a blocked PIN', {pinState: 'blocked'}, "This card's PIN is blocked"],
      ['a full card', {empty: 0}, 'This card is full'],
    ] as const)('is disabled for %s', async (_, info, caption) => {
      const {getByTestId} = renderScreen(
        {...SUMMARY, info: {...SUMMARY.info, ...info}},
        {cardMint: MINT},
      );
      await flush();

      expect(getByTestId('balance-topup').props.accessibilityState).toEqual({
        disabled: true,
      });
      expect(getByTestId('balance-topup-refusal').props.children).toBe(caption);
    });

    it('is disabled for a card not in sats', async () => {
      const {getByTestId} = renderScreen(SUMMARY, {
        cardMint: MINT,
        cardUnit: 1,
      });
      await flush();
      expect(getByTestId('balance-topup-refusal').props.children).toBe(
        "This card isn't in sats",
      );
    });

    it("keeps the owed change's slots: the last free slot owed is a full card", async () => {
      mockOwedPieces.mockResolvedValue(1);
      const {getByTestId} = renderScreen(
        {...SUMMARY, info: {...SUMMARY.info, empty: 1}},
        {cardMint: MINT},
      );
      await flush();
      expect(mockOwedPieces).toHaveBeenCalledWith(SUMMARY.pubkey);
      expect(getByTestId('balance-topup-refusal').props.children).toBe(
        'This card is full',
      );
    });

    it('shows one gold button per waiting top-up, which resumes it', async () => {
      const waiting = [{topupId: 'q-paid', amountSat: 5, state: 'paid'}];
      mockRefreshWaiting.mockResolvedValue(waiting);
      const {getByTestId, getByText} = renderScreen(SUMMARY, {
        cardMint: MINT,
        waitingTopUps: waiting as never,
      });
      await flush();

      expect(getByText('Load waiting top-up · 5 sats')).toBeTruthy();
      fireEvent.press(getByTestId('balance-topup-waiting'));
      expect(mockReplace).toHaveBeenCalledWith('CashuCardTopUp', {
        summary: SUMMARY,
        cardMint: MINT,
        cardUnit: undefined,
        resume: 'q-paid',
      });
    });

    it('says a refund is in progress, and the button resumes it (ENG-855)', async () => {
      const waiting = [{topupId: 'q-refund', amountSat: 7, state: 'refunding'}];
      mockRefreshWaiting.mockResolvedValue(waiting);
      const {getByTestId, getByText} = renderScreen(SUMMARY, {
        cardMint: MINT,
        waitingTopUps: waiting as never,
      });
      await flush();

      expect(getByText('Refund in progress · 7 sats')).toBeTruthy();
      fireEvent.press(getByTestId('balance-topup-waiting'));
      expect(mockReplace).toHaveBeenCalledWith(
        'CashuCardTopUp',
        expect.objectContaining({resume: 'q-refund'}),
      );
    });

    it('promotes a payment that landed after Cancel, on arrival', async () => {
      mockRefreshWaiting.mockResolvedValue([
        {
          topupId: 'q-late',
          amountSat: 8,
          state: 'paid',
          cardPubkey: SUMMARY.pubkey,
        },
      ]);
      const {getByText, queryByText} = renderScreen(SUMMARY, {
        cardMint: MINT,
        waitingTopUps: [
          {topupId: 'q-late', amountSat: 8, state: 'waiting'},
        ] as never,
      });
      expect(getByText('Top-up invoice open · 8 sats')).toBeTruthy();
      await flush();
      expect(getByText('Load waiting top-up · 8 sats')).toBeTruthy();
      expect(queryByText(/invoice open/)).toBeNull();
    });
  });
});
