import React from 'react';
import {NavigationContainer} from '@react-navigation/native';
import {createStackNavigator} from '@react-navigation/stack';

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
  RegisteredRewardCards,
  EventSettings,
} from '../screens';
import CashuProvision from '../screens/CashuProvision';
import CashuPayment from '../screens/CashuPayment';

// hooks
import {useAppSelector} from '../store/hooks';

// store
import {selectEventConfig} from '../store/slices/rewardSlice';

// navigation
import {navigationRef} from '../navigation/navigationRef';

const Stack = createStackNavigator<RootStackType>();

const Root = () => {
  const {username} = useAppSelector(state => state.user);
  const eventConfig = useAppSelector(selectEventConfig);

  // Determine header title based on event mode
  const isEventActive = eventConfig.eventModeEnabled && eventConfig.eventActive;
  const headerTitle =
    isEventActive && eventConfig.eventDisplayName
      ? eventConfig.eventDisplayName
      : `Pay to ${username}`;

  const initialRouteName = username ? 'Home' : 'Auth';

  return (
    <Stack.Navigator
      initialRouteName={initialRouteName}
      screenOptions={{
        headerShadowVisible: false,
        headerTitle: headerTitle,
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
          animation: 'slide_from_right',
        }}
      />
      <Stack.Screen
        name="RegisteredRewardCards"
        component={RegisteredRewardCards}
        options={{
          headerShown: false,
          animation: 'slide_from_right',
        }}
      />
      <Stack.Screen
        name="EventSettings"
        component={EventSettings}
        options={{
          headerShown: false,
          animation: 'slide_from_right',
        }}
      />
      <Stack.Screen
        name="CashuProvision"
        component={CashuProvision}
        options={{
          headerShown: true,
          headerTitle: 'Issue Flash Card',
          headerTitleStyle: {fontFamily: 'Outfit-Bold'},
          animation: 'slide_from_right',
          headerStyle: {backgroundColor: '#0a0a0a'},
          headerTintColor: '#FF6600',
        }}
      />
      <Stack.Screen
        name="CashuPayment"
        component={CashuPayment}
        options={{
          headerShown: false,
          animation: 'fade',
          gestureEnabled: false,
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
export {navigationRef};
