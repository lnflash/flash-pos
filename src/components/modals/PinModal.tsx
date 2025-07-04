import React, {useState, useEffect, useCallback} from 'react';
import {Modal, Alert} from 'react-native';
import styled from 'styled-components/native';
import {Icon} from '@rneui/themed';

type PinModalProps = {
  visible: boolean;
  mode: 'setup' | 'verify' | 'change' | 'remove';
  title: string;
  subtitle?: string;
  onSuccess: (pin: string, oldPin?: string) => void;
  onCancel: () => void;
  maxAttempts?: number;
  externalError?: string;
  onClearError?: () => void;
  onVerifyOldPin?: (pin: string) => Promise<boolean>;
};

const PinModal: React.FC<PinModalProps> = ({
  visible,
  mode,
  title,
  subtitle,
  onSuccess,
  onCancel,
  maxAttempts: _maxAttempts = 3,
  externalError,
  onClearError,
  onVerifyOldPin,
}) => {
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [oldPin, setOldPin] = useState('');
  const [step, setStep] = useState<'enter' | 'confirm' | 'old'>('enter');
  const [_attempts, _setAttempts] = useState(0);
  const [error, setError] = useState('');
  const [isVerifying, setIsVerifying] = useState(false);

  const PIN_LENGTH = 4;

  const resetModal = useCallback(() => {
    setPin('');
    setConfirmPin('');
    setOldPin('');
    setStep(mode === 'change' ? 'old' : 'enter');
    _setAttempts(0);
    setError('');
    setIsVerifying(false);
  }, [mode]);

  useEffect(() => {
    if (visible) {
      resetModal();
    }
  }, [visible, resetModal]);

  const handleNumberPress = (number: string) => {
    setError('');
    // Clear external error when user starts typing
    if (externalError && onClearError) {
      onClearError();
    }

    if (step === 'old') {
      if (oldPin.length < PIN_LENGTH) {
        setOldPin(oldPin + number);
      }
    } else if (step === 'enter') {
      if (pin.length < PIN_LENGTH) {
        setPin(pin + number);
      }
    } else if (step === 'confirm') {
      if (confirmPin.length < PIN_LENGTH) {
        setConfirmPin(confirmPin + number);
      }
    }
  };

  const handleBackspace = () => {
    setError('');

    if (step === 'old') {
      setOldPin(oldPin.slice(0, -1));
    } else if (step === 'enter') {
      setPin(pin.slice(0, -1));
    } else if (step === 'confirm') {
      setConfirmPin(confirmPin.slice(0, -1));
    }
  };

  const handleNext = useCallback(async () => {
    if (step === 'old' && oldPin.length === PIN_LENGTH) {
      // Verify old PIN before proceeding
      if (onVerifyOldPin) {
        setIsVerifying(true);
        try {
          const isValid = await onVerifyOldPin(oldPin);
          if (isValid) {
            setStep('enter');
          } else {
            setError('Incorrect current PIN. Please try again.');
            setOldPin(''); // Auto-clear on error
          }
        } catch (error) {
          setError('Verification failed. Please try again.');
          setOldPin(''); // Auto-clear on error
        } finally {
          setIsVerifying(false);
        }
      } else {
        // Fallback if no verification function provided
        setStep('enter');
      }
      return;
    }

    if (step === 'enter' && pin.length === PIN_LENGTH) {
      if (mode === 'setup' || mode === 'change') {
        setStep('confirm');
      } else {
        // Verify or Remove mode
        onSuccess(pin);
      }
      return;
    }

    if (step === 'confirm' && confirmPin.length === PIN_LENGTH) {
      if (pin === confirmPin) {
        if (mode === 'change') {
          onSuccess(pin, oldPin);
        } else {
          onSuccess(pin);
        }
      } else {
        setError('PINs do not match. Please try again.');
        // Use Alert instead of Vibration for better compatibility
        Alert.alert('Error', 'PINs do not match. Please try again.');
        setPin(''); // Auto-clear both PINs on mismatch
        setConfirmPin('');
        setStep('enter');
      }
    }
  }, [step, oldPin, pin, confirmPin, mode, onSuccess, onVerifyOldPin]);

  const getCurrentPin = () => {
    if (step === 'old') return oldPin;
    if (step === 'enter') return pin;
    return confirmPin;
  };

  const getCurrentTitle = () => {
    if (step === 'old') return 'Enter Current PIN';
    if (step === 'confirm') return 'Confirm New PIN';
    return title;
  };

  const getCurrentSubtitle = () => {
    if (step === 'old') return 'Enter your current 4-digit PIN';
    if (step === 'confirm') return 'Re-enter your new PIN to confirm';
    return subtitle;
  };

  const handleClear = () => {
    setError('');
    if (step === 'old') {
      setOldPin('');
    } else if (step === 'enter') {
      setPin('');
    } else if (step === 'confirm') {
      setConfirmPin('');
    }
  };

  // Clear PIN input when external error occurs
  useEffect(() => {
    if (externalError) {
      // Clear the current PIN input when there's an external error
      if (step === 'old') {
        setOldPin('');
      } else if (step === 'enter') {
        setPin('');
      } else if (step === 'confirm') {
        setConfirmPin('');
      }
    }
  }, [externalError, step]);

  // Auto-submit when PIN is complete
  useEffect(() => {
    const currentPin =
      step === 'old' ? oldPin : step === 'enter' ? pin : confirmPin;
    if (currentPin.length === PIN_LENGTH && !isVerifying) {
      const timer = setTimeout(() => {
        handleNext();
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [pin, confirmPin, oldPin, step, handleNext, isVerifying]);

  const numbers = [
    ['1', '2', '3'],
    ['4', '5', '6'],
    ['7', '8', '9'],
    ['clear', '0', 'backspace'],
  ];

  return (
    <Modal visible={visible} transparent animationType="fade">
      <Backdrop>
        <ModalContainer>
          <Header>
            <Title>{getCurrentTitle()}</Title>
            {getCurrentSubtitle() && (
              <Subtitle>{getCurrentSubtitle()}</Subtitle>
            )}
          </Header>

          <PinDisplay>
            {Array.from({length: PIN_LENGTH}).map((_, index) => (
              <PinDot key={index} filled={index < getCurrentPin().length} />
            ))}
          </PinDisplay>

          {error || externalError ? (
            <ErrorMessage>{error || externalError}</ErrorMessage>
          ) : null}

          {isVerifying && <VerifyingMessage>Verifying PIN...</VerifyingMessage>}

          <NumPad>
            {numbers.map((row, rowIndex) => (
              <NumRow key={rowIndex}>
                {row.map((number, colIndex) => (
                  <NumButton
                    key={colIndex}
                    onPress={() => {
                      if (number === 'backspace') {
                        handleBackspace();
                      } else if (number === 'clear') {
                        handleClear();
                      } else if (number !== '') {
                        handleNumberPress(number);
                      }
                    }}
                    disabled={number === '' || isVerifying}
                    activeOpacity={number === '' ? 1 : 0.7}>
                    {number === 'backspace' ? (
                      <Icon
                        name="backspace"
                        type="material"
                        size={24}
                        color={isVerifying ? '#ccc' : '#333'}
                      />
                    ) : number === 'clear' ? (
                      <NumText disabled={isVerifying}>C</NumText>
                    ) : (
                      <NumText disabled={isVerifying}>{number}</NumText>
                    )}
                  </NumButton>
                ))}
              </NumRow>
            ))}
          </NumPad>

          <Actions>
            <CancelButton onPress={onCancel} disabled={isVerifying}>
              <CancelButtonText disabled={isVerifying}>Cancel</CancelButtonText>
            </CancelButton>
          </Actions>
        </ModalContainer>
      </Backdrop>
    </Modal>
  );
};

export default PinModal;

const Backdrop = styled.View`
  flex: 1;
  background-color: rgba(0, 0, 0, 0.6);
  justify-content: center;
  align-items: center;
`;

const ModalContainer = styled.View`
  background-color: white;
  border-radius: 20px;
  padding: 30px;
  width: 320px;
  max-height: 80%;
`;

const Header = styled.View`
  align-items: center;
  margin-bottom: 30px;
`;

const Title = styled.Text`
  font-size: 24px;
  font-family: 'Outfit-Bold';
  color: #333;
  text-align: center;
  margin-bottom: 8px;
`;

const Subtitle = styled.Text`
  font-size: 16px;
  font-family: 'Outfit-Regular';
  color: #666;
  text-align: center;
  line-height: 22px;
`;

const PinDisplay = styled.View`
  flex-direction: row;
  justify-content: center;
  margin-bottom: 20px;
`;

const PinDot = styled.View<{filled: boolean}>`
  width: 16px;
  height: 16px;
  border-radius: 8px;
  background-color: ${props => (props.filled ? '#007856' : '#e0e0e0')};
  margin-horizontal: 8px;
`;

const ErrorMessage = styled.Text`
  font-size: 14px;
  font-family: 'Outfit-Medium';
  color: #ff4444;
  text-align: center;
  margin-bottom: 15px;
  line-height: 18px;
`;

const VerifyingMessage = styled.Text`
  font-size: 14px;
  font-family: 'Outfit-Medium';
  color: #007856;
  text-align: center;
  margin-bottom: 15px;
  line-height: 18px;
`;

const NumPad = styled.View`
  margin-bottom: 20px;
`;

const NumRow = styled.View`
  flex-direction: row;
  justify-content: space-between;
  margin-bottom: 15px;
`;

const NumButton = styled.TouchableOpacity<{disabled?: boolean}>`
  width: 60px;
  height: 60px;
  border-radius: 30px;
  background-color: ${props => (props.disabled ? '#f0f0f0' : '#f5f5f5')};
  justify-content: center;
  align-items: center;
  border: 1px solid #e0e0e0;
  opacity: ${props => (props.disabled ? 0.6 : 1)};
`;

const NumText = styled.Text<{disabled?: boolean}>`
  font-size: 24px;
  font-family: 'Outfit-Medium';
  color: ${props => (props.disabled ? '#ccc' : '#333')};
`;

const Actions = styled.View`
  align-items: center;
`;

const CancelButton = styled.TouchableOpacity<{disabled?: boolean}>`
  padding: 12px 24px;
  border-radius: 8px;
  opacity: ${props => (props.disabled ? 0.6 : 1)};
`;

const CancelButtonText = styled.Text<{disabled?: boolean}>`
  font-size: 16px;
  font-family: 'Outfit-Medium';
  color: ${props => (props.disabled ? '#ccc' : '#666')};
`;
