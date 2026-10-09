import React from 'react';
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
    expect(getByText('3 used of 32 · 28 free')).toBeTruthy();
    expect(getByText('Set')).toBeTruthy();
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

  it('"Charge this card" goes back to the keypad', () => {
    const {getByText} = renderScreen();

    fireEvent.press(getByText('Charge this card'));

    expect(mockGoBack).toHaveBeenCalledTimes(1);
  });
});
