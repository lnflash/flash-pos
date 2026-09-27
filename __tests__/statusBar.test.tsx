/**
 * ENG-613: the status-bar icons must be legible on the app's light screens on
 * every platform, OS version and system theme, from the first frame.
 *
 * App.tsx used to hand Android `light-content` on the assumption that a black
 * band sat behind the icons. Android 15+ enforces edge-to-edge and ignores
 * `StatusBar.setBackgroundColor`, so the band never paints and white icons land
 * on the white screen. This pins the tint to dark on both platforms and the
 * band to the app background, whether a platform split comes back as a
 * `Platform.OS` ternary or as `Platform.select` (see setPlatform). A split into
 * an .android.tsx file would go unseen: jest resolves modules as iOS.
 *
 * Dark icons are only half of it: what sits under them must be light too.
 * - Where the bar is transparent (Android 15+, iOS) the root SafeAreaView's
 *   inset is under the icons. Unpainted, it shows the native shell, which the
 *   system dark theme makes dark: black on iOS (systemBackgroundColor), and
 *   #303030 on Android unless styles.xml pins the window background.
 * - Before JS runs, Android shows the launch theme in styles.xml. It must agree
 *   with App.tsx in both system themes, or the icons flip at launch.
 * - The launch theme must still follow the system theme. One that declares
 *   itself light at night opts the app into the force invert dark theme, which
 *   inverts a window that renders light: the white inset, the invoice QR.
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

/**
 * Runs the rest of the test as `os`. RN's jest Platform is the iOS module: its
 * Platform.select takes the ios branch whatever Platform.OS says, so replacing
 * OS alone would let `Platform.select({ios: 'dark-content', android:
 * 'light-content'})` bring ENG-613 back unseen. Both are restored after each
 * test.
 */
const setPlatform = (os: 'android' | 'ios') => {
  jest.replaceProperty(Platform, 'OS', os);
  jest
    .spyOn(Platform, 'select')
    .mockImplementation(((spec: Record<string, unknown>) =>
      os in spec
        ? spec[os]
        : 'native' in spec
        ? spec.native
        : spec.default) as typeof Platform.select);
};

afterEach(() => {
  jest.restoreAllMocks();
});

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

/**
 * Resource files outside values/ that define AppTheme too, such as a
 * values-night/styles.xml. Each would replace the launch state for its
 * qualifier, and nothing here reads them.
 */
const findQualifiedAppThemes = () => {
  const res = path.join(__dirname, '../android/app/src/main/res');

  return fs
    .readdirSync(res)
    .filter(dir => dir.startsWith('values-'))
    .flatMap(dir =>
      fs
        .readdirSync(path.join(res, dir))
        .filter(file => file.endsWith('.xml'))
        .map(file => path.join(dir, file)),
    )
    .filter(file =>
      /<style\s+name="AppTheme"/.test(
        fs
          .readFileSync(path.join(res, file), 'utf8')
          .replace(/<!--[\s\S]*?-->/g, ''),
      ),
    );
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
      setPlatform(os);

      const tree = await renderApp();
      const bar = tree.root.findByType(StatusBar);

      expect(bar.props.barStyle).toBe('dark-content');

      act(() => tree.unmount());
    });
  });

  it('paints the band the app background, not black, for Android 7–14', async () => {
    setPlatform('android');

    const tree = await renderApp();
    const bar = tree.root.findByType(StatusBar);

    expect(bar.props.backgroundColor).toBe(STATUS_BAR_BAND);
    expect(STATUS_BAR_BAND.toLowerCase()).toBe('#ffffff');

    act(() => tree.unmount());
  });

  (['android', 'ios'] as const).forEach(os => {
    it(`paints the inset under the transparent bar on ${os} the band colour, not the native shell`, async () => {
      setPlatform(os);

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
      setPlatform('android');
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

  it('follows the system theme, so the force invert dark theme leaves the app alone', () => {
    // Force invert inverts a window only while its theme says
    // isLightTheme=true (ViewRootImpl.determineForceDarkType, API 36.1). At
    // night a DayNight parent resolves to a dark theme, which says false. A
    // Light parent, or an isLightTheme=true item, would opt the app in.
    expect(theme.parent).toMatch(/DayNight/);
    expect(theme.items['android:isLightTheme']).not.toBe('true');
  });

  it('paints the window the band colour, so the icons never sit on #303030 before JS paints', () => {
    // Android 15+ shows the window background under the transparent bar until
    // App.tsx paints the root inset. DayNight alone makes it #303030 at night.
    expect(androidColorHex(theme.items['android:windowBackground'])).toBe(
      STATUS_BAR_BAND,
    );
  });

  it('is the only AppTheme, so no qualifier such as values-night swaps these items out', () => {
    expect(findQualifiedAppThemes()).toEqual([]);
  });

  it('asks for the icons App.tsx asks for, so they do not flip when JS takes over', async () => {
    setPlatform('android');

    const tree = await renderApp();
    const {barStyle} = tree.root.findByType(StatusBar).props;

    act(() => tree.unmount());

    // Absent means false: neither half of DayNight asks for dark icons.
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
