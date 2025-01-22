import Toast from 'react-native-toast-message';

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
