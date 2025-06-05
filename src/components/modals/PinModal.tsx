import React, {useState, useEffect, useCallback} from 'react';
import {Modal, Vibration} from 'react-native';
import styled from 'styled-components/native';
import {Icon} from '@rneui/themed';

type PinModalProps = {
  visible: boolean;
  mode: 'setup' | 'verify' | 'change';
  title: string;
  subtitle?: string;
  onSuccess: (pin: string, oldPin?: string) => void;
  onCancel: () => void;
  maxAttempts?: number;
  externalError?: string;
  onClearError?: () => void;
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
}) => {
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [oldPin, setOldPin] = useState('');
  const [step, setStep] = useState<'enter' | 'confirm' | 'old'>('enter');
  const [_attempts, _setAttempts] = useState(0);
  const [error, setError] = useState('');

  const PIN_LENGTH = 4;

  const resetModal = useCallback(() => {
    setPin('');
    setConfirmPin('');
    setOldPin('');
    setStep(mode === 'change' ? 'old' : 'enter');
    _setAttempts(0);
    setError('');
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

  const handleNext = () => {
    if (step === 'old' && oldPin.length === PIN_LENGTH) {
      setStep('enter');
      return;
    }

    if (step === 'enter' && pin.length === PIN_LENGTH) {
      if (mode === 'setup' || mode === 'change') {
        setStep('confirm');
      } else {
        // Verify mode
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
        Vibration.vibrate(200);
        setPin('');
        setConfirmPin('');
        setStep('enter');
      }
    }
  };

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

  // Manual submission - user taps when ready

  const numbers = [
    ['1', '2', '3'],
    ['4', '5', '6'],
    ['7', '8', '9'],
    ['', '0', 'backspace'],
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

          <NumPad>
            {numbers.map((row, rowIndex) => (
              <NumRow key={rowIndex}>
                {row.map((number, colIndex) => (
                  <NumButton
                    key={colIndex}
                    onPress={() => {
                      if (number === 'backspace') {
                        handleBackspace();
                      } else if (number !== '') {
                        handleNumberPress(number);
                      }
                    }}
                    disabled={number === ''}
                    activeOpacity={number === '' ? 1 : 0.7}>
                    {number === 'backspace' ? (
                      <Icon
                        name="backspace"
                        type="material"
                        size={24}
                        color="#333"
                      />
                    ) : (
                      <NumText>{number}</NumText>
                    )}
                  </NumButton>
                ))}
              </NumRow>
            ))}
          </NumPad>

          <Actions>
            {getCurrentPin().length === PIN_LENGTH && (
              <SubmitButton onPress={handleNext}>
                <SubmitButtonText>
                  {step === 'confirm' ? 'Confirm' : 'Continue'}
                </SubmitButtonText>
              </SubmitButton>
            )}
            <CancelButton onPress={onCancel}>
              <CancelButtonText>Cancel</CancelButtonText>
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

const NumPad = styled.View`
  margin-bottom: 20px;
`;

const NumRow = styled.View`
  flex-direction: row;
  justify-content: space-between;
  margin-bottom: 15px;
`;

const NumButton = styled.TouchableOpacity`
  width: 60px;
  height: 60px;
  border-radius: 30px;
  background-color: #f5f5f5;
  justify-content: center;
  align-items: center;
  border: 1px solid #e0e0e0;
`;

const NumText = styled.Text`
  font-size: 24px;
  font-family: 'Outfit-Medium';
  color: #333;
`;

const Actions = styled.View`
  align-items: center;
`;

const SubmitButton = styled.TouchableOpacity`
  background-color: #007856;
  padding: 12px 24px;
  border-radius: 8px;
  margin-bottom: 10px;
  min-width: 120px;
`;

const SubmitButtonText = styled.Text`
  font-size: 16px;
  font-family: 'Outfit-Medium';
  color: #ffffff;
  text-align: center;
`;

const CancelButton = styled.TouchableOpacity`
  padding: 12px 24px;
  border-radius: 8px;
`;

const CancelButtonText = styled.Text`
  font-size: 16px;
  font-family: 'Outfit-Medium';
  color: #666;
`;
