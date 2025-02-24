import * as React from 'react';
import Toast, {
  SuccessToast,
  ErrorToast,
  BaseToastProps,
} from 'react-native-toast-message';

export const toastConfig = {
  success: (props: BaseToastProps) => (
    <SuccessToast
      {...props}
      text1NumberOfLines={3}
      text1Style={{fontSize: 16}}
    />
  ),
  error: (props: BaseToastProps) => (
    <ErrorToast {...props} text1NumberOfLines={3} text1Style={{fontSize: 16}} />
  ),
};

export const toastShow = ({
  message,
  onHide,
  type = 'success',
  autoHide,
  position = 'top',
}: {
  message: string;
  onHide?: () => void;
  type?: 'error' | 'success' | 'info';
  autoHide?: boolean;
  position?: 'top' | 'bottom';
}): void => {
  Toast.show({
    type,
    text1: message,
    position,
    bottomOffset: 80,
    onHide,
    visibilityTime: 5000,
    autoHide,
  });
};
