import React, {useEffect, useState} from 'react';
import {useWindowDimensions} from 'react-native';
import styled from 'styled-components/native';
import * as Progress from 'react-native-progress';

const USD_MAX_INVOICE_TIME = 5; // minutes
const PROGRESS_BAR_MAX_WIDTH = 100; // percent
const USD_INVOICE_EXPIRE_INTERVAL = 60 * 5;

type Props = {
  setErrMessage: (value: string) => void;
};

const ExpireTime: React.FC<Props> = ({setErrMessage}) => {
  const {width} = useWindowDimensions();

  const [progress, setProgress] = useState(PROGRESS_BAR_MAX_WIDTH);
  const [seconds, setSeconds] = useState(0);
  const [minutes, setMinutes] = useState(USD_MAX_INVOICE_TIME);
  const [expiresAt, setExpiresAt] = useState(USD_MAX_INVOICE_TIME);

  useEffect(() => {
    const timerStartTime = new Date();

    timerStartTime.setSeconds(
      timerStartTime.getSeconds() + USD_INVOICE_EXPIRE_INTERVAL,
    );

    const interval = setInterval(() => {
      const currentTime = new Date();
      const elapsedTime = timerStartTime.getTime() - currentTime.getTime();
      const remainingSeconds = Math.ceil(elapsedTime / 1000);

      if (remainingSeconds <= 0) {
        clearInterval(interval);
        setErrMessage(`Invoice has expired.\nGenerate a new invoice!`);
      } else {
        setMinutes(Math.floor(remainingSeconds / 60));
        setSeconds(remainingSeconds % 60);
        setProgress(
          PROGRESS_BAR_MAX_WIDTH -
            (elapsedTime / (USD_INVOICE_EXPIRE_INTERVAL * 1000)) * 100,
        );
      }
    }, 1000);

    return () => clearInterval(interval);
  }, []);

  return (
    <ProgressWrapper>
      <Time>{`${minutes}:${seconds}`}</Time>
      <Progress.Bar
        progress={progress / 100}
        width={width * 0.7}
        color="#002118"
        height={10}
      />
      <Time>{`${expiresAt}:00`}</Time>
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
  font-size: 15px;
  font-family: 'Outfit-SemiBold';
  color: #002118;
`;
