import 'react-native-gesture-handler/jestSetup';

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
