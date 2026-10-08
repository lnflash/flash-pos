/**
 * NfcButton — the invoice header's NFC affordance. It hands the tap to the
 * card payment router and nothing else: the router owns the support checks,
 * the session, the alerts and the merchant-cancel handling (ENG-614).
 */
import React from 'react';
import {Alert} from 'react-native';
import NfcManager from 'react-native-nfc-manager';
import {act, fireEvent, render} from '@testing-library/react-native';

import NfcButton from '../../src/components/invoice/NfcButton';

const mockSetOptions = jest.fn();
const mockRouteCardPayment = jest.fn();

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({setOptions: mockSetOptions}),
}));

jest.mock('../../src/hooks/useCardPaymentRouter', () => ({
  useCardPaymentRouter: () => ({
    routeCardPayment: (...args: unknown[]) => mockRouteCardPayment(...args),
    isScanning: false,
  }),
}));

const mockNfc = NfcManager as jest.Mocked<typeof NfcManager>;

let alertSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  mockRouteCardPayment.mockResolvedValue(false);
  alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

/** Mounts the button and renders the headerRight it installs. */
function renderHeaderButton() {
  render(<NfcButton />);
  expect(mockSetOptions).toHaveBeenCalledTimes(1);
  const {headerRight} = mockSetOptions.mock.calls[0][0];
  return render(headerRight());
}

describe('NfcButton', () => {
  it('installs itself as the header right button', () => {
    const header = renderHeaderButton();
    expect(header.getByText('NFC')).toBeTruthy();
  });

  it('a press starts NFC and hands the tap to the card payment router', async () => {
    const header = renderHeaderButton();

    await act(async () => {
      fireEvent.press(header.getByText('NFC'));
    });

    expect(mockNfc.start).toHaveBeenCalledTimes(1);
    expect(mockRouteCardPayment).toHaveBeenCalledTimes(1);
    // The router does these itself; a second copy here would double the
    // alerts on a device without NFC.
    expect(mockNfc.isSupported).not.toHaveBeenCalled();
    expect(mockNfc.isEnabled).not.toHaveBeenCalled();
    expect(alertSpy).not.toHaveBeenCalled();
  });
});
