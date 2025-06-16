import Toast, {
  SuccessToast,
  ErrorToast,
  BaseToastProps,
} from 'react-native-toast-message';

const toastStyle = {fontSize: 14};

export const toastConfig = {
  success: (props: BaseToastProps) => (
    <SuccessToast {...props} text1NumberOfLines={3} text1Style={toastStyle} />
  ),
  error: (props: BaseToastProps) => (
    <ErrorToast {...props} text1NumberOfLines={3} text1Style={toastStyle} />
  ),
};

interface ToastProps {
  message: string;
  onHide?: () => void;
  type?: 'error' | 'success' | 'info';
  autoHide?: boolean;
  position?: 'top' | 'bottom';
}

interface ToastProps {
  message: string;
  onHide?: () => void;
  type?: 'error' | 'success' | 'info';
  autoHide?: boolean;
  position?: 'top' | 'bottom';
}

export const toastShow = ({
  message,
  onHide,
  type = 'success',
  autoHide,
  position = 'top',
}: ToastProps): void => {
}: ToastProps): void => {
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
