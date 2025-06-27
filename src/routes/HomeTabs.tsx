import React from 'react';
import styled from 'styled-components/native';
import {Text, PlatformPressable} from '@react-navigation/elements';
import {Icon} from '@rneui/themed';
import {
  BottomTabBarProps,
  createBottomTabNavigator,
} from '@react-navigation/bottom-tabs';

// hooks
import {useAppSelector} from '../store/hooks';
import {useLinkBuilder} from '@react-navigation/native';

// store
import {selectRewardConfig} from '../store/slices/rewardSlice';

// screens
import {Keypad, Profile, Rewards, SupportChat} from '../screens';

// assets
import Background from '../assets/icons/background.png';

const Tab = createBottomTabNavigator();

const tabs = [
  {label: 'POS', icon: 'apps-outline', iconActive: 'apps'},
  {label: 'Rewards', icon: 'diamond-outline', iconActive: 'diamond'},
  {label: 'Support', icon: 'chatbox-outline', iconActive: 'chatbox'},
  {label: 'Profile', icon: 'cog-outline', iconActive: 'cog'},
];

const MyTabBar = ({state, descriptors, navigation}: BottomTabBarProps) => {
  const {buildHref} = useLinkBuilder();
  const rewardConfig = useAppSelector(selectRewardConfig);

  // Create dynamic tabs array based on standalone rewards setting
  const dynamicTabs = rewardConfig.showStandaloneRewards
    ? tabs
    : tabs.filter(tab => tab.label !== 'Rewards');

  return (
    <Wrapper>
      {state.routes.map((route, index) => {
        // Skip rendering Rewards tab if standalone rewards are disabled
        if (route.name === 'Rewards' && !rewardConfig.showStandaloneRewards) {
          return null;
        }

        const {options} = descriptors[route.key];
        const isFocused = state.index === index;

        // Find the correct tab configuration for this route
        const tabConfig = dynamicTabs.find(tab => {
          if (route.name === 'Keypad') return tab.label === 'POS';
          if (route.name === 'Rewards') return tab.label === 'Rewards';
          if (route.name === 'Support') return tab.label === 'Support';
          if (route.name === 'Profile') return tab.label === 'Profile';
          return false;
        });

        if (!tabConfig) return null;

        const onPress = () => {
          const event = navigation.emit({
            type: 'tabPress',
            target: route.key,
            canPreventDefault: true,
          });

          if (!isFocused && !event.defaultPrevented) {
            // Clear parameters for Rewards tab to ensure standalone rewards (21 points)
            const navParams =
              route.name === 'Rewards' ? undefined : route.params;
            navigation.navigate(route.name, navParams);
          }
        };

        const onLongPress = () => {
          navigation.emit({
            type: 'tabLongPress',
            target: route.key,
          });
        };

        return (
          <TabBar
            key={route.name}
            href={buildHref(route.name, route.params)}
            accessibilityState={isFocused ? {selected: true} : {}}
            accessibilityLabel={options.tabBarAccessibilityLabel}
            testID={options.tabBarButtonTestID}
            onPress={onPress}
            onLongPress={onLongPress}
            style={{flex: 1}}>
            <Icon
              name={isFocused ? tabConfig.iconActive : tabConfig.icon}
              size={24}
              type="ionicon"
              color={isFocused ? '#41AC48' : '#83899b'}
            />
            <TabBarLabel active={isFocused}>{tabConfig.label}</TabBarLabel>
          </TabBar>
        );
      })}
      <Image source={Background} />
    </Wrapper>
  );
};

export const HomeTabs = () => {
  const {username} = useAppSelector(state => state.user);
  const rewardConfig = useAppSelector(selectRewardConfig);

  return (
    <Tab.Navigator
      tabBar={props => <MyTabBar {...props} />}
      screenOptions={{
        headerShadowVisible: false,
        headerTitle: `Pay to ${username}`,
        headerTitleStyle: {fontFamily: 'Outfit-Bold'},
        headerTitleAlign: 'center',
        animation: 'shift',
      }}>
      <Tab.Screen name="Keypad" component={Keypad} />
      {rewardConfig.showStandaloneRewards && (
        <Tab.Screen
          name="Rewards"
          component={Rewards}
          options={{headerShown: false}}
        />
      )}
      <Tab.Screen
        name="Support"
        component={SupportChat}
        options={{headerShown: false}}
      />
      <Tab.Screen
        name="Profile"
        component={Profile}
        options={{headerShown: false}}
      />
    </Tab.Navigator>
  );
};

const Wrapper = styled.View`
  flex-direction: row;
  position: absolute;
  bottom: 10px;
  left: 30px;
  right: 30px;
  border-top-width: 0;
  border-radius: 360px;
  background-color: #fff;
  overflow: hidden;
  elevation: 5;
`;

const TabBar = styled(PlatformPressable)`
  align-items: center;
  justify-content: center;
  padding-vertical: 5px;
`;

const TabBarLabel = styled(Text)<{active: boolean}>`
  font-size: 14px;
  font-family: ${({active}) => (active ? 'Outfit-SemiBold' : 'Outfit-Medium')};
  color: ${({active}) => (active ? '#41AC48' : '#83899b')};
`;

const Image = styled.ImageBackground`
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  bottom: 0;
  z-index: -1;
  resize-mode: contain;
`;
