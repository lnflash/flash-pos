import React, {useCallback, useEffect, useRef, useState} from 'react';
import {AppState} from 'react-native';
import styled from 'styled-components/native';

import {
  cashuOutstanding,
  type CashuOutstanding,
} from '../../services/cashuAutoSettle';

/**
 * The loud one. When the device is offline (or a sweep failed), tapped value
 * sits in the settlement queue or the settled store — real money the merchant
 * cannot see in their wallet. This banner names the amount and the leg
 * holding it, and stays up until an automatic run clears it.
 *
 * Hidden entirely when nothing is outstanding: a clean till shows nothing.
 */
const PendingSettlementBanner = () => {
  const [outstanding, setOutstanding] = useState<CashuOutstanding | null>(null);
  const mountedRef = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const o = await cashuOutstanding();
      if (mountedRef.current) {
        setOutstanding(o);
      }
    } catch {
      // A read failure must not flip the banner to "all clear" — the last
      // known state is the honest one.
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    refresh();
    const appState = AppState.addEventListener('change', state => {
      if (state === 'active') {
        refresh();
      }
    });
    const interval = setInterval(refresh, 15000);
    return () => {
      mountedRef.current = false;
      appState.remove();
      clearInterval(interval);
    };
  }, [refresh]);

  if (!outstanding) {
    return null;
  }
  const {queueSat, queueCount, settledSat} = outstanding;
  if (queueSat === 0 && settledSat === 0) {
    return null;
  }

  return (
    <Banner>
      <BannerText>
        ⚠ {queueSat + settledSat} sat awaiting payout
      </BannerText>
      <BannerSub>
        {queueCount > 0
          ? `${queueCount} tapped payment(s) settle automatically when online. `
          : ''}
        {settledSat > 0
          ? `${settledSat} sat settled at the mint, sweeping to your wallet.`
          : ''}
      </BannerSub>
    </Banner>
  );
};

export default PendingSettlementBanner;

const Banner = styled.View`
  background-color: #fff4d6;
  border-left-width: 4px;
  border-left-color: #d97706;
  border-radius: 8px;
  padding: 12px;
  margin-bottom: 12px;
`;

const BannerText = styled.Text`
  font-size: 14px;
  font-family: 'Outfit-SemiBold';
  color: #92400e;
`;

const BannerSub = styled.Text`
  font-size: 12px;
  font-family: 'Outfit-Regular';
  color: #92400e;
  margin-top: 4px;
`;
