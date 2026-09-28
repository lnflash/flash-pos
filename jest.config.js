const base = {
  preset: 'react-native',
  setupFiles: ['<rootDir>/jest.setup.js'],
  moduleNameMapper: {
    '@react-native-async-storage/async-storage':
      '@react-native-async-storage/async-storage/jest/async-storage-mock.js',
    '@env': '<rootDir>/__mocks__/@env.js',
  },
  transformIgnorePatterns: [
    'node_modules/(?!(react-native|@react-native|@react-navigation|@rneui|react-redux|@reduxjs|redux-persist|react-native-animatable|react-native-vector-icons|react-native-toast-message|react-native-url-polyfill|react-native-nfc-manager|react-native-gesture-handler|react-native-safe-area-context|react-native-screens|react-native-size-matters|react-native-keyboard-aware-scroll-view|react-native-iphone-x-helper|@cashu|@noble|@scure|@apollo|js-lnurl)/)',
  ],
};

module.exports = {
  projects: [
    {...base, displayName: 'ios'},
    // ENG-613: the status-bar spec runs a second time with modules resolved
    // as Android, the way a device loads them. A platform split evaluated
    // when App.tsx loads (a module-scope Platform.select or ternary, or an
    // .android.tsx file) is otherwise computed as iOS in every case.
    {
      ...base,
      displayName: 'android',
      haste: {
        defaultPlatform: 'android',
        platforms: ['android', 'ios', 'native'],
      },
      testMatch: ['<rootDir>/__tests__/statusBar.test.tsx'],
    },
  ],
};
