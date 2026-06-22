import React from 'react';
import {act, render} from '@testing-library/react-native';
import ExpireTime from '../../src/components/invoice/ExpireTime';

jest.mock('react-native-progress', () => {
  const MockReact = require('react');
  const {Text} = require('react-native');

  return {
    Bar: ({progress}: {progress: number}) =>
      MockReact.createElement(Text, null, `progress:${progress}`),
  };
});

describe('ExpireTime', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-06-22T15:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('shows a 60 second invoice window', () => {
    const setErrMessage = jest.fn();
    const {getAllByText, getByText} = render(
      <ExpireTime setErrMessage={setErrMessage} />,
    );

    expect(getAllByText('1:00')).toHaveLength(2);

    act(() => {
      jest.advanceTimersByTime(1000);
    });

    expect(getByText('0:59')).toBeTruthy();
    expect(setErrMessage).not.toHaveBeenCalled();
  });

  it('expires the invoice after 60 seconds', () => {
    const setErrMessage = jest.fn();
    render(<ExpireTime setErrMessage={setErrMessage} />);

    act(() => {
      jest.advanceTimersByTime(60_000);
    });

    expect(setErrMessage).toHaveBeenCalledWith(
      'Invoice has expired.\nGenerate a new invoice!',
    );
  });
});
