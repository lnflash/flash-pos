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

// screens
import {Main, Paycode, Profile} from '../screens';

// assets
import Background from '../assets/icons/background.png';

const Tab = createBottomTabNavigator();

const tabs = [
  {label: 'POS', icon: 'apps-outline', iconActive: 'apps'},
  {label: 'Paycode', icon: 'qr-code-outline', iconActive: 'qr-code'},
  {label: 'Profile', icon: 'cog-outline', iconActive: 'cog'},
];

const MyTabBar = ({state, descriptors, navigation}: BottomTabBarProps) => {
  const {buildHref} = useLinkBuilder();

  return (
    <Wrapper>
      {state.routes.map((route, index) => {
        const {options} = descriptors[route.key];

        const isFocused = state.index === index;

        const onPress = () => {
          const event = navigation.emit({
            type: 'tabPress',
            target: route.key,
            canPreventDefault: true,
          });

          if (!isFocused && !event.defaultPrevented) {
            navigation.navigate(route.name, route.params);
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
              name={isFocused ? tabs[index].iconActive : tabs[index].icon}
              size={24}
              type="ionicon"
              color={isFocused ? '#41AC48' : '#83899b'}
            />
            <TabBarLabel active={isFocused}>{tabs[index].label}</TabBarLabel>
          </TabBar>
        );
      })}
      <Image source={Background} />
    </Wrapper>
  );
};

export const HomeTabs = () => {
  const {username} = useAppSelector(state => state.user);

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
      <Tab.Screen name="Main" component={Main} />
      <Tab.Screen
        name="Paycode"
        component={Paycode}
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
  bottom: 20px;
  left: 50px;
  right: 50px;
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
