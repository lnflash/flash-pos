import React from 'react';
import {fireEvent, render} from '@testing-library/react-native';
import {Provider} from 'react-redux';
import {configureStore} from '@reduxjs/toolkit';
import {FLASH_LN_ADDRESS, FLASH_LN_ADDRESS_URL} from '@env';
import Paycode from '../../src/screens/Paycode';
import rootReducer from '../../src/store/reducers';

const mockPrintPaycode = jest.fn();
jest.mock('../../src/hooks', () => ({
  usePrint: () => ({
    printPaycode: mockPrintPaycode,
  }),
}));

// The components barrel drags in react-native-progress (ESM, untransformed in
// jest); the screen only needs the real PrimaryButton.
jest.mock('../../src/components', () => ({
  PrimaryButton: jest.requireActual(
    '../../src/components/buttons/PrimaryButton',
  ).default,
}));

// The QR renderer pulls in react-native-svg's native views; the screen's copy
// is what these tests assert on, so a stand-in that records the encoded value
// is enough.
jest.mock('react-native-qrcode-svg', () => {
  const MockReact = require('react');
  const {Text} = require('react-native');
  return ({value}: {value: string}) =>
    MockReact.createElement(Text, {testID: 'qr-value'}, value);
});

const renderPaycode = (username = 'TestMerchant') => {
  const store = configureStore({
    reducer: rootReducer,
    preloadedState: {
      user: {
        username,
        walletId: 'wallet-1',
        walletCurrency: 'USD',
        loading: false,
        error: '',
      },
    },
  });
  return render(
    <Provider store={store}>
      <Paycode />
    </Provider>,
  );
};

describe('Paycode screen', () => {
  beforeEach(() => {
    mockPrintPaycode.mockClear();
  });

  it('renders the pay title and subtitle for the signed-in username', () => {
    const {getByText} = renderPaycode('TestMerchant');

    expect(getByText(`Pay TestMerchant@${FLASH_LN_ADDRESS}`)).toBeTruthy();
    expect(
      getByText(
        'Display this static QR code online or in person to allow anybody to pay testmerchant.',
      ),
    ).toBeTruthy();
  });

  it('encodes the LNURL-pay link for the username in the QR code', () => {
    const {getByTestId} = renderPaycode('TestMerchant');

    const value = getByTestId('qr-value').props.children as string;
    expect(
      value.startsWith(`${FLASH_LN_ADDRESS_URL}/TestMerchant?lightning=`),
    ).toBe(true);
    expect(value).toMatch(/lightning=lnurl1/i);
  });

  it('keeps the existing scanning-help description', () => {
    const {getByText} = renderPaycode();

    expect(getByText(/Having trouble scanning this QR code/)).toBeTruthy();
  });

  it('tells the merchant PayCode payments do not land in this app (issue #45)', () => {
    const {getByTestId, getByText} = renderPaycode();

    expect(getByTestId('paycode-history-note')).toBeTruthy();
    expect(
      getByText(
        /Payments to this QR code are credited to your Flash account and appear in the Flash app\. They are not listed in this app's Transaction History\./,
      ),
    ).toBeTruthy();
  });

  it('prints the paycode from the print button', () => {
    const {getByText} = renderPaycode();

    fireEvent.press(getByText('Print QR code'));

    expect(mockPrintPaycode).toHaveBeenCalledTimes(1);
  });
});
