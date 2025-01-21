import React, {createContext, useState} from 'react';
import {ActivityIndicator} from 'react-native';
import styled from 'styled-components/native';

interface ActivityIndicatorInterface {
  toggleLoading: (loading: boolean) => void;
  loadableVisible: boolean;
}

export const ActivityIndicatorContext =
  createContext<ActivityIndicatorInterface>({
    toggleLoading: () => {},
    loadableVisible: false,
  });

type Props = {
  children: string | JSX.Element | JSX.Element[];
};

export const ActivityIndicatorProvider = ({children}: Props) => {
  const [visible, toggleLoading] = useState<boolean>(false);

  return (
    <ActivityIndicatorContext.Provider
      value={{loadableVisible: visible, toggleLoading}}>
      {children}
      {visible && (
        <Backdrop>
          <ActivityIndicator color={'#41ac48'} size={'large'} />
        </Backdrop>
      )}
    </ActivityIndicatorContext.Provider>
  );
};

const Backdrop = styled.View`
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 1;
  align-items: center;
  justify-content: center;
  background-color: rgba(0, 0, 0, 0);
`;
