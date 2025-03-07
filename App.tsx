/**
 * Sample React Native App
 * https://github.com/facebook/react-native
 *
 * @format
 */

import React from 'react';
import {StatusBar} from 'react-native';
import {Provider} from 'react-redux';
import {ApolloProvider} from '@apollo/client';
import Toast from 'react-native-toast-message';
import {PersistGate} from 'redux-persist/integration/react';

// store
import {store, persistor} from './src/store';

// routes
import Layout from './src/routes';

// gql
import client from './src/graphql/ApolloClient';

// contexts
import {ActivityIndicatorProvider} from './src/contexts/ActivityIndicator';
import {FlashcardProvider} from './src/contexts/Flashcard';

// utils
import {toastConfig} from './src/utils/toast';

function App(): React.JSX.Element {
  return (
    <Provider store={store}>
      <PersistGate loading={null} persistor={persistor}>
        <StatusBar barStyle={'light-content'} backgroundColor={'#000'} />
        <ApolloProvider client={client}>
          <ActivityIndicatorProvider>
            <FlashcardProvider>
              <Layout />
            </FlashcardProvider>
            <Toast config={toastConfig} />
          </ActivityIndicatorProvider>
        </ApolloProvider>
      </PersistGate>
    </Provider>
  );
}

export default App;
