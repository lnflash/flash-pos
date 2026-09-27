/**
 * ENG-613: the status-bar icons must be legible on the app's light screens on
 * every platform, OS version and system theme, from the first frame.
 *
 * App.tsx used to hand Android `light-content` on the assumption that a black
 * band sat behind the icons. Android 15+ enforces edge-to-edge and ignores
 * `StatusBar.setBackgroundColor`, so the band never paints and white icons land
 * on the white screen. This pins the tint to dark on both platforms and the
 * band to the app background, so the platform ternary cannot come back.
 *
 * Dark icons are only half of it: what sits under them must be light too.
 * - Where the bar is transparent (Android 15+, iOS) the root SafeAreaView's
 *   inset is under the icons. Unpainted, it showed the native shell, which the
 *   system dark theme makes dark: #303030 on Android while the theme was
 *   DayNight, black on iOS (systemBackgroundColor).
 * - Before JS runs, Android shows the launch theme in styles.xml. It must agree
 *   with App.tsx or the icons flip at launch, and it must not follow the system
 *   dark theme.
 * - The JS values must apply on the first render. Inside PersistGate they
 *   waited for the store to rehydrate, with the launch state still showing.
 *
 * @format
 */

import 'react-native';
import React from 'react';
import fs from 'fs';
import path from 'path';
import {Platform, StatusBar, StyleSheet} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import {afterEach, describe, expect, it, jest} from '@jest/globals';
import renderer, {act} from 'react-test-renderer';

jest.mock('../src/routes', () => {
  const {View} = require('react-native');

  return () => require('react').createElement(View);
});

/**
 * Holds PersistGate shut on demand, as it is on a cold start while the store
 * rehydrates from AsyncStorage. Open, it is the real gate. Read only at render
 * time: jest.mock is hoisted above this declaration.
 */
const mockStore = {rehydrated: true};

jest.mock('redux-persist/integration/react', () => {
  const {createElement} = require('react');
  const {PersistGate} = jest.requireActual<
    typeof import('redux-persist/integration/react')
  >('redux-persist/integration/react');

  return {
    PersistGate: (props: React.ComponentProps<typeof PersistGate>) =>
      mockStore.rehydrated
        ? createElement(PersistGate, props)
        : props.loading ?? null,
  };
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

/** The AppTheme style in styles.xml: its parent and its items, comments out. */
const readAndroidAppTheme = () => {
  const xml = fs
    .readFileSync(
      path.join(__dirname, '../android/app/src/main/res/values/styles.xml'),
      'utf8',
    )
    .replace(/<!--[\s\S]*?-->/g, '');
  const style = xml.match(
    /<style\s+name="AppTheme"\s+parent="([^"]+)"\s*>([\s\S]*?)<\/style>/,
  );

  if (!style) {
    throw new Error('AppTheme not found in styles.xml');
  }

  const items: Record<string, string> = {};
  for (const [, name, value] of style[2].matchAll(
    /<item\s+name="([^"]+)"\s*>([^<]*)<\/item>/g,
  )) {
    items[name] = value.trim();
  }

  return {parent: style[1], items};
};

/** A styles.xml colour as the #RRGGBB App.tsx writes, where it can be read. */
const androidColorHex = (value: string | undefined) => {
  if (value === '@android:color/white') {
    return '#FFFFFF';
  }

  const hex = value?.match(/^#(?:ff)?([0-9a-f]{6})$/i);

  return hex ? `#${hex[1].toUpperCase()}` : value;
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

  (['android', 'ios'] as const).forEach(os => {
    it(`paints the inset under the transparent bar on ${os} the band colour, not the native shell`, async () => {
      jest.replaceProperty(Platform, 'OS', os);

      const tree = await renderApp();
      const root = tree.root.findByType(SafeAreaView);

      expect(StyleSheet.flatten(root.props.style).backgroundColor).toBe(
        STATUS_BAR_BAND,
      );

      act(() => tree.unmount());
    });
  });

  describe('while the store is still rehydrating', () => {
    afterEach(() => {
      mockStore.rehydrated = true;
    });

    it('is already applied, rather than waiting on PersistGate', async () => {
      jest.replaceProperty(Platform, 'OS', 'android');
      mockStore.rehydrated = false;

      const tree = await renderApp();
      const bar = tree.root.findByType(StatusBar);

      expect(bar.props.barStyle).toBe('dark-content');
      expect(bar.props.backgroundColor).toBe(STATUS_BAR_BAND);

      act(() => tree.unmount());
    });
  });
});

describe('the Android launch theme, shown before JS runs', () => {
  const theme = readAndroidAppTheme();

  it('is light, so the system dark theme cannot darken what sits under the dark icons', () => {
    expect(theme.parent).not.toMatch(/DayNight/);
    expect(theme.parent).toMatch(/\.Light\./);
  });

  it('asks for the icons App.tsx asks for, so they do not flip when JS takes over', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');

    const tree = await renderApp();
    const {barStyle} = tree.root.findByType(StatusBar).props;

    act(() => tree.unmount());

    // Absent means false: the light parent leaves the icons white.
    expect(theme.items['android:windowLightStatusBar'] === 'true').toBe(
      barStyle === 'dark-content',
    );
  });

  it('paints the band the colour App.tsx paints it, on Android 7–14', () => {
    expect(androidColorHex(theme.items['android:statusBarColor'])).toBe(
      STATUS_BAR_BAND,
    );
  });
});
