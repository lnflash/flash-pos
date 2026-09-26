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
 * What the status-bar band is painted where Android still draws one: the app's
 * own background, so the band is invisible against the screen below it.
 */
export const STATUS_BAR_BAND = '#FFFFFF';

function App(): React.JSX.Element {
  return (
    <SafeAreaView style={styles.container}>
      <Provider store={store}>
        <PersistGate loading={null} persistor={persistor}>
          {/* Dark icons on both platforms: the app has one light look (ENG-613).
              Android used to get white icons over a black band, but Android 15+
              enforces edge-to-edge and ignores setBackgroundColor, so the band
              never paints and the white icons landed on the white screen. The
              band is kept and painted the app's own background for Android 7–14
              (minSdk 24), where the window still draws a real one and RN would
              otherwise fall back to colorPrimaryDark grey. */}
          <StatusBar
            barStyle="dark-content"
            backgroundColor={STATUS_BAR_BAND}
          />
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
  },
});

export default App;
