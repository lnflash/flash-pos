/**
 * ENG-613: the status-bar icons must be legible on the app's light screens on
 * every platform.
 *
 * App.tsx used to hand Android `light-content` on the assumption that a black
 * band sat behind the icons. Android 15+ enforces edge-to-edge and ignores
 * `StatusBar.setBackgroundColor`, so the band never paints and white icons land
 * on the white screen. This pins the tint to dark on both platforms and the
 * band to the app background, so the platform ternary cannot come back.
 *
 * @format
 */

import 'react-native';
import React from 'react';
import {Platform, StatusBar} from 'react-native';
import {describe, expect, it, jest} from '@jest/globals';
import renderer, {act} from 'react-test-renderer';

jest.mock('../src/routes', () => {
  const {View} = require('react-native');

  return () => require('react').createElement(View);
});

import App, {STATUS_BAR_BAND} from '../App';

const renderApp = async () => {
  let tree: ReturnType<typeof renderer.create> | undefined;

  await act(async () => {
    tree = renderer.create(<App />);
    await Promise.resolve();
  });

  return tree!;
};

describe('the status bar', () => {
  (['android', 'ios'] as const).forEach(os => {
    it(`uses dark icons on ${os}, so they read on the light screens`, async () => {
      jest.replaceProperty(Platform, 'OS', os);

      const tree = await renderApp();
      const bar = tree.root.findByType(StatusBar);

      expect(bar.props.barStyle).toBe('dark-content');

      act(() => tree.unmount());
    });
  });

  it('paints the band the app background, not black, for Android 7–14', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');

    const tree = await renderApp();
    const bar = tree.root.findByType(StatusBar);

    expect(bar.props.backgroundColor).toBe(STATUS_BAR_BAND);
    expect(STATUS_BAR_BAND.toLowerCase()).toBe('#ffffff');

    act(() => tree.unmount());
  });
});
