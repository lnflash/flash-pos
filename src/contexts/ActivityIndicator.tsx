import React, {createContext, useState} from 'react';
import {Dimensions} from 'react-native';
import {BallIndicator} from 'react-native-indicators';
import styled from 'styled-components/native';

const {width} = Dimensions.get('screen');

interface ActivityIndicatorInterface {
  toggleLoading: (loading: boolean) => void;
  loadableVisible: boolean;
}

const defaultValue: ActivityIndicatorInterface = {
  toggleLoading: () => {},
  loadableVisible: false,
};

export const ActivityIndicatorContext = createContext(defaultValue);

type Props = {
  children: React.ReactNode;
};

export const ActivityIndicatorProvider = ({children}: Props) => {
  const [visible, toggleLoading] = useState(false);

  const value = {loadableVisible: visible, toggleLoading};

  return (
    <ActivityIndicatorContext.Provider value={value}>
      {children}
      {visible && <ActivityIndicator />}
    </ActivityIndicatorContext.Provider>
  );
};

export const ActivityIndicator = () => (
  <Backdrop>
    <BallIndicator size={width / 3} color="#002118" />
  </Backdrop>
);

const Backdrop = styled.View`
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 1;
  align-items: center;
  justify-content: center;
  background-color: transparent;
`;
