module.exports = {
  preset: 'react-native',
  moduleNameMapper: {
    '@react-native-async-storage/async-storage':
      '@react-native-async-storage/async-storage/jest/async-storage-mock.js',
    '@env': '<rootDir>/__mocks__/@env.js',
  },
  transformIgnorePatterns: [
    'node_modules/(?!(react-native|@react-native|react-native-animatable|react-native-vector-icons)/)',
  ],
};
