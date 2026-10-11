import React from 'react';
import {fireEvent, render} from '@testing-library/react-native';

import PinPad from '../../../src/components/cashu/PinPad';

jest.mock('react-native-vector-icons/FontAwesome6', () => 'Icon');

describe('PinPad testIDs (ENG-634)', () => {
  it('gives every key a stable pin-key-* id that presses the same handler as its label', () => {
    const onDigit = jest.fn();
    const onBackspace = jest.fn();
    const onClear = jest.fn();
    const {getByTestId} = render(
      <PinPad onDigit={onDigit} onBackspace={onBackspace} onClear={onClear} />,
    );

    for (const d of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0']) {
      fireEvent.press(getByTestId(`pin-key-${d}`));
    }
    expect(onDigit.mock.calls.map(([d]) => d).join('')).toBe('1234567890');

    fireEvent.press(getByTestId('pin-key-back'));
    expect(onBackspace).toHaveBeenCalledTimes(1);
    fireEvent.press(getByTestId('pin-key-clear'));
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});
