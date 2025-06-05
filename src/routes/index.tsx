import React from 'react';
import {NavigationContainer} from '@react-navigation/native';
import {createNativeStackNavigator} from '@react-navigation/native-stack';

// screens
import {HomeTabs} from './HomeTabs';
import {
  Auth,
  FlashcardBalance,
  Invoice,
  Paycode,
  Rewards,
  RewardsSettings,
  RewardsSuccess,
  Success,
  TransactionHistory,
} from '../screens';

// hooks
import {useAppSelector} from '../store/hooks';

// navigation
import {navigationRef} from '../navigation/navigationRef';

const Stack = createNativeStackNavigator<RootStackType>();

const Root = () => {
  const {username} = useAppSelector(state => state.user);

  const initialRouteName = username ? 'Home' : 'Auth';

  return (
    <Stack.Navigator
      initialRouteName={initialRouteName}
      screenOptions={{
        headerShadowVisible: false,
        headerTitle: `Pay to ${username}`,
        headerTitleStyle: {fontFamily: 'Outfit-Bold'},
        headerTitleAlign: 'center',
      }}>
      <Stack.Screen
        name="Auth"
        component={Auth}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="Home"
        component={HomeTabs}
        options={{headerShown: false}}
      />
      <Stack.Screen name="Invoice" component={Invoice} />
      <Stack.Screen
        name="Rewards"
        component={Rewards}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="Success"
        component={Success}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="RewardsSuccess"
        component={RewardsSuccess}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="FlashcardBalance"
        component={FlashcardBalance}
        options={{
          headerShown: true,
          headerTitle: 'Flashcard Balance',
          animation: 'fade_from_bottom',
        }}
      />
      <Stack.Screen
        name="TransactionHistory"
        component={TransactionHistory}
        options={{
          headerShown: false,
          animation: 'slide_from_right',
        }}
      />
      <Stack.Screen
        name="RewardsSettings"
        component={RewardsSettings}
        options={{
          headerShown: false,
          animation: 'slide_from_right',
        }}
      />
      <Stack.Screen
        name="Paycode"
        component={Paycode}
        options={{
          headerShown: false,
          animation: 'slide_from_right',
        }}
      />
    </Stack.Navigator>
  );
};

const Layout = () => {
  return (
    <NavigationContainer ref={navigationRef}>
      <Root />
    </NavigationContainer>
  );
};

export default Layout;
