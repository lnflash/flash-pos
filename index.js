/**
 * @format
 */

// Hermes ships neither TextEncoder/TextDecoder, webcrypto's getRandomValues,
// nor a complete URL — and the cashu stack needs all of them: @cashu/cashu-ts
// instantiates TextDecoders at module top level, generates blinding factors
// via noble's randomBytes (crypto.getRandomValues), and reads URL members RN's
// built-in stub leaves unimplemented (`URL.protocol`). These imports must
// stay ahead of anything that transitively pulls in the cashu stack.
import 'react-native-get-random-values';
import 'text-encoding-polyfill';
import 'react-native-url-polyfill/auto';

import {AppRegistry} from 'react-native';
import {enableScreens} from 'react-native-screens';

enableScreens(false);

const App = require('./App').default;
const {name: appName} = require('./app.json');

AppRegistry.registerComponent(appName, () => App);
