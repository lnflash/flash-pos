module.exports = {
  root: true,
  extends: '@react-native',
  overrides: [
    {
      // Node scripts (scripts/card-relay/phone.cjs): plain CommonJS on the
      // Node the harness runs, outside the React Native babel parser.
      files: ['*.cjs'],
      parser: 'espree',
      parserOptions: {ecmaVersion: 2022, sourceType: 'script'},
      env: {node: true, es2022: true},
    },
  ],
};
