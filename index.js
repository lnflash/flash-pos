/**
 * @format
 */

import {AppRegistry} from 'react-native';
import {enableScreens} from 'react-native-screens';

enableScreens(false);

const App = require('./App').default;
const {name: appName} = require('./app.json');

AppRegistry.registerComponent(appName, () => App);
