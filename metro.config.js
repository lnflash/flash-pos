const {getDefaultConfig, mergeConfig} = require('@react-native/metro-config');

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const config = {
  resolver: {
    // @cashu/cashu-ts v4 is ESM-only and declares no `main` — only package
    // `exports`. Without this flag Metro cannot resolve it.
    unstable_enablePackageExports: true,
    // With exports resolution on, packages importing `tslib` (apollo et al)
    // would pick tslib's ESM build, whose namespace comes up undefined under
    // Metro's interop (`Cannot read property '__extends' of undefined`).
    // Preferring the require/react-native conditions keeps CJS builds —
    // cashu-ts is unaffected: its exports have no `require` key, so it still
    // falls through to `default` (its ESM bundle).
    unstable_conditionNames: ['require', 'react-native'],
  },
  transformer: {
    getTransformOptions: async () => ({
      transform: {
        experimentalImportSupport: false,
        inlineRequires: false,
      },
    }),
    assetPlugins: ['react-native-svg-asset-plugin'],
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
