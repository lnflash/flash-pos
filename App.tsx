/**
 * Sample React Native App
 * https://github.com/facebook/react-native
 *
 * @format
 */

import React from 'react';
import {StatusBar} from 'react-native';
import {ApolloProvider} from '@apollo/client';

import Layout from './src/routes';
import client from './src/graphql/ApolloClient';
import {ActivityIndicatorProvider} from './src/contexts/ActivityIndicator';

function App(): React.JSX.Element {
  return (
    <>
      <StatusBar barStyle={'light-content'} backgroundColor={'#fff'} />
      <ApolloProvider client={client}>
        <ActivityIndicatorProvider>
          <Layout />
        </ActivityIndicatorProvider>
      </ApolloProvider>
    </>
  );
}

export default App;
