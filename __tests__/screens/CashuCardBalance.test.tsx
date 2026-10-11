import React from 'react';
import {StyleSheet} from 'react-native';
import {fireEvent, render} from '@testing-library/react-native';

import CashuCardBalance from '../../src/screens/CashuCardBalance';
import type {CardSummary} from '../../src/services/cashuCard';

jest.mock('react-native-svg', () => require('../../__mocks__/svgStub'));

const mockGoBack = jest.fn();
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
  },
  pubkey: '02c0ffee' + 'ab'.repeat(29),
  balance: 500,
};

const renderScreen = (
  summary: CardSummary = SUMMARY,
  extra: {owedChangeSat?: number; changeAddedSat?: number} = {},
) =>
  render(
    <CashuCardBalance
      navigation={{goBack: mockGoBack} as never}
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
    ['locked', 'Locked'],
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
});
