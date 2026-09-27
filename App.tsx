/**
 * Sample React Native App
 * https://github.com/facebook/react-native
 *
 * @format
 */

import React from 'react';
import {StatusBar, StyleSheet} from 'react-native';
import {Provider} from 'react-redux';
import {ApolloProvider} from '@apollo/client';
import Toast from 'react-native-toast-message';
import {PersistGate} from 'redux-persist/integration/react';
import {SafeAreaView} from 'react-native-safe-area-context';

// store
import {store, persistor} from './src/store';

// routes
import Layout from './src/routes';

// gql
import client from './src/graphql/ApolloClient';

// contexts
import {ActivityIndicatorProvider} from './src/contexts/ActivityIndicator';
import {FlashcardProvider} from './src/contexts/Flashcard';

// cashu auto-settle
import CashuAutoSettle from './src/components/cashu/CashuAutoSettle';

// utils
import {toastConfig} from './src/utils/toast';

/**
 * The colour under the status-bar icons, on every platform, OS version and
 * system theme. The icons are dark, so it must stay light (ENG-613).
 *
 * What sits under the icons depends on where the app runs:
 * - Android 7–14 (minSdk 24): an opaque band drawn by the window. Before JS runs
 *   it is `android:statusBarColor` in android/app/src/main/res/values/styles.xml,
 *   then the <StatusBar> backgroundColor below. Both are this colour.
 * - Android 15+ (targetSdk 35): edge-to-edge is enforced, the bar is transparent
 *   and setBackgroundColor is a no-op. The app draws under the bar, so the root
 *   SafeAreaView's top inset shows, and the root paints it this colour
 *   (styles.container). Before JS runs it is the launch theme's
 *   `android:windowBackground`, also this colour, in both system themes.
 * - iOS: the bar is always transparent, so the same root inset shows.
 */
export const STATUS_BAR_BAND = '#FFFFFF';

function App(): React.JSX.Element {
  return (
    <SafeAreaView style={styles.container}>
      {/* Dark icons on both platforms (ENG-613). Android used to get white
          icons over a black band, but Android 15+ never paints the band, so the
          white icons landed on the white screens.

          The screens are all light, but the native shells behind them follow
          the system theme: under the system dark theme the iOS root view is
          black (systemBackgroundColor), and AppTheme's DayNight parent would
          make the Android window #303030 if styles.xml did not pin it white.
          Where the bar is transparent that shell is what shows through an
          unpainted inset, so the root paints the band colour itself rather than
          trusting it.

          Mounted outside PersistGate so it applies on the first render: inside
          the gate it waited for the store to rehydrate, with the native launch
          state still on screen. It reads nothing from the store. The launch
          state in styles.xml matches it, so nothing flips when JS takes over. */}
      <StatusBar barStyle="dark-content" backgroundColor={STATUS_BAR_BAND} />
      <Provider store={store}>
        <PersistGate loading={null} persistor={persistor}>
          <ApolloProvider client={client}>
            <ActivityIndicatorProvider>
              <FlashcardProvider>
                <CashuAutoSettle />
                <Layout />
              </FlashcardProvider>
              <Toast config={toastConfig} />
            </ActivityIndicatorProvider>
          </ApolloProvider>
        </PersistGate>
      </Provider>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    // What shows under the status bar wherever it is transparent (Android 15+,
    // iOS). Left unpainted, that is the native root view, which the system dark
    // theme turns black on iOS. See STATUS_BAR_BAND.
    backgroundColor: STATUS_BAR_BAND,
  },
});

export default App;
