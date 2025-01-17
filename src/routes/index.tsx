import React from 'react';
import {NavigationContainer} from '@react-navigation/native';
import {createNativeStackNavigator} from '@react-navigation/native-stack';

// screens
import {Auth, Main} from '../screens';

const Stack = createNativeStackNavigator<RootStackType>();

const Root = () => {
  return (
    <Stack.Navigator
      initialRouteName="Auth"
      screenOptions={{
        headerTitle: '',
        headerShown: false,
        headerShadowVisible: false,
      }}>
      <Stack.Screen name="Auth" component={Auth} />
      <Stack.Screen name="Main" component={Main} />
    </Stack.Navigator>
  );
};

const Layout = () => {
  return (
    <NavigationContainer>
      <Root />
    </NavigationContainer>
  );
};

export default Layout;
