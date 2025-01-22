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

// store
import {store} from './src/store';

// routes
import Layout from './src/routes';

// gql
import client from './src/graphql/ApolloClient';

// contexts
import {ActivityIndicatorProvider} from './src/contexts/ActivityIndicator';

function App(): React.JSX.Element {
  return (
    <Provider store={store}>
      <StatusBar barStyle={'light-content'} backgroundColor={'#000'} />
      <ApolloProvider client={client}>
        <ActivityIndicatorProvider>
          <Layout />
          <Toast />
        </ActivityIndicatorProvider>
      </ApolloProvider>
    </Provider>
  );
}

export default App;
