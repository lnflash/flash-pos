import React from 'react';
import {NavigationContainer} from '@react-navigation/native';
import {createNativeStackNavigator} from '@react-navigation/native-stack';

// screens
import {Auth, Invoice, Main, Success} from '../screens';

// hooks
import {useAppSelector} from '../store/hooks';

const Stack = createNativeStackNavigator<RootStackType>();

const Root = () => {
  const {username} = useAppSelector(state => state.user);

  return (
    <Stack.Navigator
      initialRouteName="Auth"
      screenOptions={{
        headerTitle: '',
        headerShadowVisible: false,
      }}>
      <Stack.Screen
        name="Auth"
        component={Auth}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="Main"
        component={Main}
        options={{
          headerBackVisible: false,
          headerTitle: `Pay to ${username}`,
          headerTitleStyle: {fontFamily: 'Outfit-Bold'},
          headerTitleAlign: 'center',
        }}
      />
      <Stack.Screen
        name="Invoice"
        component={Invoice}
        options={{
          headerTitle: `Pay to ${username}`,
          headerTitleStyle: {fontFamily: 'Outfit-Bold'},
          headerTitleAlign: 'center',
        }}
      />
      <Stack.Screen
        name="Success"
        component={Success}
        options={{headerShown: false}}
      />
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
