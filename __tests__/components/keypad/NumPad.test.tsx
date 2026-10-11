import React from 'react';
import {fireEvent, render} from '@testing-library/react-native';

import NumPad from '../../../src/components/keypad/NumPad';

const mockDispatch = jest.fn();

jest.mock('react-native-vector-icons/FontAwesome6', () => 'Icon');

jest.mock('../../../src/store/hooks', () => ({
  useAppDispatch: () => mockDispatch,
  useAppSelector: (selector: (state: unknown) => unknown) =>
    selector({
      amount: {currency: {fractionDigits: 0}, isPrimaryAmountSats: true},
    }),
}));

jest.mock('../../../src/store/slices/amountSlice', () => ({
  updateAmount: (type: string, digit?: string) => ({type, digit}),
}));

describe('NumPad testIDs (ENG-634)', () => {
  it('gives every digit a stable numpad-* id that enters that digit', () => {
    const {getByTestId} = render(<NumPad />);

    for (const d of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0']) {
      fireEvent.press(getByTestId(`numpad-${d}`));
    }

    expect(mockDispatch.mock.calls.map(([action]) => action.digit)).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9',
      '0',
    ]);
    expect(
      mockDispatch.mock.calls.every(([action]) => action.type === 'addDigit'),
    ).toBe(true);
  });
});
