module.exports = {
  presets: ['module:@react-native/babel-preset'],
  plugins: [
    [
      'module-resolver',
      {
        root: ['./src'],
      },
    ],
    [
      'dotenv-import',
      {
        moduleName: '@env',
        path: '.env',
      },
    ],
    // Optional settings: a build whose .env (or environment) lacks one gets
    // `undefined` and the code's own default, where '@env' above fails the
    // build on a missing name. Only the names allowlisted here may be read
    // this way; everything else stays strict.
    [
      'dotenv-import',
      {
        moduleName: '@env-optional',
        path: '.env',
        allowUndefined: true,
        allowlist: ['FLASH_HEADER_APIS', 'FLASH_LADDER_CHANGE'],
      },
      'dotenv-import-optional',
    ],
  ],
};
