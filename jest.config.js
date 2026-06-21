module.exports = {
  preset: 'react-native',
  setupFiles: ['<rootDir>/jest.setup.js'],
  moduleNameMapper: {
    '@react-native-async-storage/async-storage':
      '@react-native-async-storage/async-storage/jest/async-storage-mock.js',
    '@env': '<rootDir>/__mocks__/@env.js',
  },
  transformIgnorePatterns: [
    'node_modules/(?!(react-native|@react-native|@react-navigation|@rneui|react-redux|@reduxjs|redux-persist|react-native-animatable|react-native-vector-icons|react-native-toast-message|react-native-url-polyfill|react-native-nfc-manager|react-native-gesture-handler|react-native-safe-area-context|react-native-screens|react-native-size-matters)/)',
  ],
};
