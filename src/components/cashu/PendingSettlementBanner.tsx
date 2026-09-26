import React, {useCallback, useEffect, useRef, useState} from 'react';
import {AppState} from 'react-native';
import styled from 'styled-components/native';

import {useAppSelector} from '../../store/hooks';
import {
  cashuOutstanding,
  runAutoSettlement,
  type CashuOutstanding,
} from '../../services/cashuAutoSettle';
import {toastShow} from '../../utils/toast';

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
  const [settling, setSettling] = useState(false);
  const mountedRef = useRef(true);
  const username = useAppSelector(state => state.user.username);

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

  const settleNow = useCallback(async () => {
    setSettling(true);
    try {
      const result = await runAutoSettlement(username);
      if (result.paidSat != null && result.paidSat > 0) {
        toastShow({
          message: `Cashu: paid out ${result.paidSat} sat to your wallet`,
          type: 'success',
        });
      } else if (result.payoutError) {
        toastShow({
          message: `Cashu payout pending: ${result.payoutError}`,
          type: 'error',
        });
      } else if (result.stillPending > 0) {
        toastShow({
          message: 'Cashu: settlement retrying — the mint is throttling, it will clear',
          type: 'info',
        });
      }
    } catch {
      toastShow({message: 'Cashu: settlement run failed — retrying automatically', type: 'error'});
    } finally {
      setSettling(false);
      refresh();
    }
  }, [username, refresh]);

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
  const {queueSat, queueCount, settledSat, failedCount, failedSat} = outstanding;
  if (queueSat === 0 && settledSat === 0 && failedCount === 0) {
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
        {failedCount > 0
          ? `${failedCount} settlement(s) failed (${failedSat} sat) — Settle now retries them.`
          : ''}
      </BannerSub>
      <SettleBtn onPress={settleNow} disabled={settling}>
        <SettleText>{settling ? 'Settling…' : 'Settle now'}</SettleText>
      </SettleBtn>
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

const SettleBtn = styled.TouchableOpacity`
  margin-top: 10px;
  align-self: flex-start;
  background-color: #d97706;
  border-radius: 6px;
  padding-vertical: 6px;
  padding-horizontal: 14px;
`;

const SettleText = styled.Text`
  font-size: 12px;
  font-family: 'Outfit-SemiBold';
  color: #ffffff;
`;
