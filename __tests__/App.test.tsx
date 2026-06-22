/**
 * @format
 */

import 'react-native';
import React from 'react';

// Note: import explicitly to use the types shipped with jest.
import {it} from '@jest/globals';

// Note: test renderer must be required after react-native.
import renderer, {act} from 'react-test-renderer';

jest.mock('../src/routes', () => {
  const {View} = require('react-native');

  return () => require('react').createElement(View);
});

import App from '../App';

it('renders correctly', async () => {
  let testRenderer: ReturnType<typeof renderer.create> | undefined;

  await act(async () => {
    testRenderer = renderer.create(<App />);
    await Promise.resolve();
  });

  act(() => {
    testRenderer?.unmount();
  });
});
