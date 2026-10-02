/**
 * Sample React Native App
 * https://github.com/facebook/react-native
 *
 * @format
 */

import React from 'react';
import {Platform, StatusBar, StyleSheet} from 'react-native';
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
// the card charge's edge-to-edge green (status and gesture bar insets)
import EdgeTint from './src/components/EdgeTint';

// utils
import {toastConfig} from './src/utils/toast';

function App(): React.JSX.Element {
  return (
    <SafeAreaView style={styles.container}>
      <EdgeTint />
      <Provider store={store}>
        <PersistGate loading={null} persistor={persistor}>
          <StatusBar
            barStyle={Platform.OS === 'ios' ? 'dark-content' : 'light-content'}
            backgroundColor={'#000'}
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
    // The status- and gesture-bar insets show this (Android 15+ draws
    // edge to edge): white, like the screens, instead of the theme's
    // #fafafa band — the card charge's green strips sit on top of it.
    backgroundColor: '#fff',
  },
});

export default App;
