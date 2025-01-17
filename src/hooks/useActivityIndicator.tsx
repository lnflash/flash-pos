import {useContext} from 'react';
import {ActivityIndicatorContext} from '../contexts/ActivityIndicator';

interface ContextProps {
  toggleLoading: (visible: boolean) => void;
}

export const useActivityIndicator = () => {
  const context: ContextProps = useContext(ActivityIndicatorContext);
  return context;
};
