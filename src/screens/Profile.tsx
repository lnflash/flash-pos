import React, {useEffect, useState} from 'react';
import styled from 'styled-components/native';
import {StackNavigationProp} from '@react-navigation/stack';
import {useNavigation} from '@react-navigation/native';

// components
import {TextButton, PinModal} from '../components';

// store
import {useAppDispatch, useAppSelector} from '../store/hooks';
import {resetUserData} from '../store/slices/userSlice';
import {resetAmount} from '../store/slices/amountSlice';
import {
  selectHasPin,
  loadPinState,
  setPin,
  authenticatePin,
  removePin,
  changePin,
  clearAuthentication,
  clearResults,
  verifyPinOnly,
} from '../store/slices/pinSlice';
import {selectEventModeEnabled} from '../store/slices/rewardSlice';

// utils
import {isRewardsEnabled} from '../utils/featureFlags';

import {Account, Security, Settings, Transactions} from '../components/profile';


export type PinMode = 'setup' | 'verify' | 'change' | 'remove';

type Props = StackNavigationProp<RootStackType, 'Home'>;

const logoutButtonStyle = {marginTop: 20, marginBottom: 150};

const Profile = () => {
  const navigation = useNavigation<Props>();

  const dispatch = useAppDispatch();

  const eventModeEnabled = useAppSelector(selectEventModeEnabled);
  const rewardsFeatureEnabled = isRewardsEnabled();

  // PIN management

  const hasPin = useAppSelector(selectHasPin);

  const [pinModalVisible, setPinModalVisible] = useState(false);
  const [pinError, setPinError] = useState('');
  const [pinModalMode, setPinModalMode] = useState<PinMode>('verify');
  const [isViewRewardSettings, setIsViewRewardSettings] = useState(false);

  useEffect(() => {
    dispatch(loadPinState());
  }, [dispatch]);

  const onLogout = () => {
    dispatch(resetUserData());
    dispatch(resetAmount());
    navigation.replace('Auth');
  };

  const onViewRewardSettings = () => {
    setPinError('');
    dispatch(clearResults());

    if (!rewardsFeatureEnabled) {
      navigation.navigate('RewardsSettings');
      return;
    }

    setIsViewRewardSettings(true);

    if (!hasPin) {
      // First time setup - create PIN
      setPinModalMode('setup');
      setPinModalVisible(true);
    } else {
      // PIN exists - always require verification for security
      setPinModalMode('verify');
      setPinModalVisible(true);
    }
  };

  const handleVerifyOldPin = async (oldPin: string): Promise<boolean> => {
    try {
      return await dispatch(verifyPinOnly(oldPin)).unwrap();
    } catch {
      return false;
    }
  };

  const handlePinSuccess = async (pin: string, oldPin?: string) => {
    dispatch(clearResults());

    if (pinModalMode === 'setup') {
      await dispatch(setPin(pin));
      setPinModalVisible(false);
      if (isViewRewardSettings) {
        setIsViewRewardSettings(false);
        navigation.navigate('RewardsSettings');
      }
    } else if (pinModalMode === 'change') {
      if (oldPin) {
        const changed = await dispatch(changePin({oldPin, newPin: pin})).unwrap();
        if (changed) {
          setPinModalVisible(false);
          setPinError('');
        } else {
          setPinError('Failed to change PIN. Please try again.');
        }
      }
    } else if (pinModalMode === 'remove') {
      // Remove mode - verify PIN first, then remove if correct
      dispatch(clearAuthentication());
      const authenticated = await dispatch(authenticatePin(pin)).unwrap();
      if (authenticated) {
        await dispatch(removePin());
        setPinModalVisible(false);
        setPinError('');
      } else {
        setPinError('Incorrect PIN. Cannot remove PIN protection.');
      }
    } else {
      // Verify mode - clear any previous authentication state first
      dispatch(clearAuthentication());

      // Then verify the PIN
      const authenticated = await dispatch(authenticatePin(pin)).unwrap();
      if (authenticated) {
        setPinModalVisible(false);
        setPinError('');
        if (isViewRewardSettings) {
          setIsViewRewardSettings(false);
          navigation.navigate('RewardsSettings');
        }
      } else {
        setPinError('Incorrect PIN. Please try again.');
      }
    }
  };

  const handlePinCancel = () => {
    setPinError('');
    dispatch(clearResults());
    setPinModalVisible(false);
  };

  const handlePinActions = (mode: PinMode) => {
    setPinError('');
    dispatch(clearResults());
    setPinModalMode(mode);
    setPinModalVisible(true);
  };


  const onViewEventSettings = () => {
    navigation.navigate('EventSettings');
  };

  return (
    <ScrollWrapper showsVerticalScrollIndicator={false}>
      <Account />
      <Settings
        onViewRewardSettings={onViewRewardSettings}
        eventModeEnabled={eventModeEnabled}
        onViewEventSettings={onViewEventSettings}
      />

      <Security hasPin={hasPin} handlePinActions={handlePinActions} />
      <Transactions />
      <TextButton
        title="Logout"
        btnStyle={logoutButtonStyle}
        onPress={onLogout}
      />
      <PinModal
        visible={pinModalVisible}
        mode={pinModalMode}
        title={
          pinModalMode === 'setup'
            ? 'Set PIN for Settings'
            : pinModalMode === 'change'
            ? 'Change PIN'
            : pinModalMode === 'remove'
            ? 'Remove PIN Protection'
            : 'Enter PIN'
        }
        subtitle={
          pinModalMode === 'setup'
            ? 'Create a 4-digit PIN to protect reward settings'
            : pinModalMode === 'change'
            ? 'Enter your current PIN, then set a new one'
            : pinModalMode === 'remove'
            ? 'Enter your current PIN to remove PIN protection'
            : 'Enter your PIN to access reward settings'
        }
        onSuccess={handlePinSuccess}
        onCancel={handlePinCancel}
        externalError={pinError}
        onClearError={() => setPinError('')}
        onVerifyOldPin={
          pinModalMode === 'change' ? handleVerifyOldPin : undefined
        }
      />
    </ScrollWrapper>
  );
};

export default Profile;

const ScrollWrapper = styled.ScrollView`
  flex-grow: 1;
  background-color: #ffffff;
  padding-top: 20px;
  padding-horizontal: 16px;
`;
