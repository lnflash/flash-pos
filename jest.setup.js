import 'react-native-gesture-handler/jestSetup';

// CI runs Node 20, which has no global WebSocket. graphql-ws's createClient
// needs one at module load (src/graphql/ApolloClient.ts), so App.test.tsx
// (which imports App) fails to run. Node 22+ provides it globally, masking
// this locally. `ws` is already a dependency.
global.WebSocket = require('ws');

/* global jest */

jest.mock('@rneui/themed', () => {
  const React = require('react');
  const {Text} = require('react-native');

  return {
    Icon: ({name}) => React.createElement(Text, null, name),
  };
});

jest.mock('react-native-toast-message', () => {
  const Toast = () => null;
  Toast.show = jest.fn();
  Toast.hide = jest.fn();

  return {
    __esModule: true,
    default: Toast,
  };
});

jest.mock('react-native-keychain', () => ({
  setGenericPassword: jest.fn(() => Promise.resolve(true)),
  getGenericPassword: jest.fn(() => Promise.resolve(false)),
  resetGenericPassword: jest.fn(() => Promise.resolve(true)),
}));

jest.mock('react-native-nfc-manager', () => ({
  __esModule: true,
  default: {
    start: jest.fn(),
    isSupported: jest.fn(() => Promise.resolve(false)),
    isEnabled: jest.fn(() => Promise.resolve(false)),
    setEventListener: jest.fn(),
    registerTagEvent: jest.fn(),
    cancelTechnologyRequest: jest.fn(),
    unregisterTagEvent: jest.fn(),
  },
  Ndef: {
    text: {
      decodePayload: jest.fn(() => ''),
    },
  },
  NfcEvents: {
    DiscoverTag: 'DiscoverTag',
    SessionClosed: 'SessionClosed',
  },
}));
