/**
 * The package mocked WITHOUT `NfcError`.
 *
 * `cashuCardNfc` reads `NfcError` defensively and degrades to the generic
 * branch if it is absent. That is stated as a contract in the module header,
 * but the main test file mocks the package with the *real* NfcError hierarchy,
 * so nothing exercised the fallback — the guard and its memoization could be
 * deleted with every test still green.
 *
 * This file exists to make that contract real. It needs its own module registry
 * because the message table is memoized on first use.
 */
jest.mock('react-native-nfc-manager', () => ({
  __esModule: true,
  default: {
    isSupported: jest.fn(() => Promise.resolve(true)),
    isEnabled: jest.fn(() => Promise.resolve(true)),
    requestTechnology: jest.fn(() => Promise.resolve()),
    cancelTechnologyRequest: jest.fn(() => Promise.resolve()),
    isoDepHandler: {transceive: jest.fn()},
  },
  NfcTech: {IsoDep: 'IsoDep'},
  // NfcError deliberately absent.
}));

import {
  describeCardFailure,
  isUserCancel,
} from '../../src/services/cashuCardNfc';
import {CardError} from '../../src/services/cashuCard';

describe('with NfcError absent from the package', () => {
  it('describeCardFailure falls back to the error message instead of crashing', () => {
    expect(describeCardFailure(new Error('boom'))).toBe('boom');
  });

  it('still reports card status words, which do not depend on NfcError', () => {
    expect(describeCardFailure(new CardError(0x6983, 'SPEND_PROOF'))).toContain(
      'card locked',
    );
  });

  it('falls back for a non-Error value', () => {
    expect(describeCardFailure('nope')).toBe('Card read failed');
  });

  it('isUserCancel returns false rather than throwing on a missing class', () => {
    expect(isUserCancel(new Error('anything'))).toBe(false);
    expect(isUserCancel(undefined)).toBe(false);
  });
});
