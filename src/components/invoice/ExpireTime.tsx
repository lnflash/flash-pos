import React, {useEffect, useState} from 'react';
import {useWindowDimensions} from 'react-native';
import styled from 'styled-components/native';
import * as Progress from 'react-native-progress';
import {POS_INVOICE_EXPIRATION_SECONDS} from '../../constants/invoice';

const PROGRESS_BAR_MAX_WIDTH = 100;
const formatRemainingTime = (remainingSeconds: number) => {
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
};

type Props = {
  setErrMessage: (value: string) => void;
};

const ExpireTime: React.FC<Props> = ({setErrMessage}) => {
  const {width} = useWindowDimensions();

  const [progress, setProgress] = useState(PROGRESS_BAR_MAX_WIDTH);
  const [remainingSeconds, setRemainingSeconds] = useState(
    POS_INVOICE_EXPIRATION_SECONDS,
  );

  useEffect(() => {
    const timerStartTime = new Date();

    timerStartTime.setSeconds(
      timerStartTime.getSeconds() + POS_INVOICE_EXPIRATION_SECONDS,
    );

    const interval = setInterval(() => {
      const currentTime = new Date();
      const elapsedTime = timerStartTime.getTime() - currentTime.getTime();
      const nextRemainingSeconds = Math.ceil(elapsedTime / 1000);

      if (nextRemainingSeconds <= 0) {
        clearInterval(interval);
        setRemainingSeconds(0);
        setProgress(0);
        setErrMessage('Invoice has expired.\nGenerate a new invoice!');
      } else {
        setRemainingSeconds(nextRemainingSeconds);
        setProgress(
          (elapsedTime / (POS_INVOICE_EXPIRATION_SECONDS * 1000)) *
            PROGRESS_BAR_MAX_WIDTH,
        );
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [setErrMessage]);

  return (
    <ProgressWrapper>
      <Time>{formatRemainingTime(remainingSeconds)}</Time>
      <Progress.Bar
        progress={progress / 100}
        width={width * 0.7}
        color="#002118"
        height={10}
      />
      <Time>{formatRemainingTime(POS_INVOICE_EXPIRATION_SECONDS)}</Time>
    </ProgressWrapper>
  );
};

export default ExpireTime;

const ProgressWrapper = styled.View`
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
`;

const Time = styled.Text`
  font-size: 12px;
  font-family: 'Outfit-SemiBold';
  color: #002118;
`;
