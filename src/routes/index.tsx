import React from 'react';
import {NavigationContainer} from '@react-navigation/native';
import {createNativeStackNavigator} from '@react-navigation/native-stack';

// screens
import {Auth, Main} from '../screens';

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
        headerShown: false,
        headerShadowVisible: false,
      }}>
      <Stack.Screen name="Auth" component={Auth} />
      <Stack.Screen
        name="Main"
        component={Main}
        options={{
          headerShown: true,
          headerTitle: `Pay ${username}`,
          headerTitleStyle: {fontFamily: 'Outfit-Bold'},
        }}
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
