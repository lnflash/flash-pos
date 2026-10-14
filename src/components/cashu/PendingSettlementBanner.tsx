import React, {useCallback, useEffect, useRef, useState} from 'react';
import {AppState} from 'react-native';
import styled from 'styled-components/native';

import {useAppSelector} from '../../store/hooks';
import {
  cashuOutstanding,
  lastAutoSettleResult,
  runAutoSettlement,
  SWEEP_MIN_SAT,
  type CashuOutstanding,
} from '../../services/cashuAutoSettle';
import {
  acknowledgeFailed,
  listSettlements,
  pruneFailed,
} from '../../services/cashuSettlement';
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
  const [payoutError, setPayoutError] = useState<string | undefined>();
  const [settling, setSettling] = useState(false);
  const mountedRef = useRef(true);
  const username = useAppSelector(state => state.user.username);

  const refresh = useCallback(async () => {
    try {
      const o = await cashuOutstanding();
      if (mountedRef.current) {
        setOutstanding(o);
        setPayoutError(lastAutoSettleResult()?.payoutError);
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
      // TEMP DEBUG — pending 8-sat entry diagnosis (remove when resolved).
      const entries = await listSettlements();
      console.log(
        '[settle-debug]',
        JSON.stringify(
          entries.map(e => ({
            id: e.id.slice(-16),
            status: e.status,
            attempts: e.attempts,
            witness: !!e.witness,
            amount: e.amount,
            lastError: e.lastError,
          })),
        ),
      );
      console.log('[settle-result]', JSON.stringify(result));
      if (result.paidSat != null && result.paidSat > 0) {
        toastShow({
          message: `eCash: paid out ${result.paidSat} sat to your wallet`,
          type: 'success',
        });
      } else if (result.payoutError) {
        toastShow({
          message: `eCash payout pending: ${result.payoutError}`,
          type: 'error',
        });
      } else if (result.stillPending > 0) {
        toastShow({
          message:
            'eCash: settlement retrying — the mint is throttling, it will clear',
          type: 'info',
        });
      } else if (result.settled > 0) {
        toastShow({
          message: `eCash: settled ${result.settled} tapped payment(s)${
            result.skippedPayout ? ` — ${result.skippedPayout}` : ''
          }`,
          type: 'info',
        });
      } else if (result.skippedPayout) {
        toastShow({message: `eCash: ${result.skippedPayout}`, type: 'info'});
      }
    } catch {
      toastShow({
        message: 'eCash: settlement run failed — retrying automatically',
        type: 'error',
      });
    } finally {
      setSettling(false);
      refresh();
    }
  }, [username, refresh]);

  // Operator assertion: those failed settles were reconciled outside the app
  // (recovered on-card, settled by hand) — retire them so the banner can rest.
  const dismissFailed = useCallback(async () => {
    setSettling(true);
    try {
      const entries = await listSettlements();
      let n = 0;
      for (const e of entries) {
        if (e.status === 'failed' && !e.acknowledgedAt) {
          if (await acknowledgeFailed(e.id, Date.now())) {
            n += 1;
          }
        }
      }
      await pruneFailed();
      if (n > 0) {
        toastShow({
          message: `eCash: retired ${n} reconciled settlement(s)`,
          type: 'info',
        });
      }
    } catch {
      toastShow({
        message: 'eCash: could not retire the failed settlements',
        type: 'error',
      });
    } finally {
      setSettling(false);
      refresh();
    }
  }, [refresh]);

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
  const {queueSat, queueCount, settledSat, failedCount, failedSat} =
    outstanding;
  if (queueSat === 0 && settledSat === 0 && failedCount === 0) {
    return null;
  }
  // A settled remainder under the minimum, with nothing queued and nothing
  // failed, is not an alarm: it is routine (a lightning-address sweep's
  // unused fee reserve comes back as change and lands here) and it sweeps
  // with the next sale. A quiet line, no ⚠ and no Settle now, since a run
  // would only skip it again.
  if (queueSat === 0 && failedCount === 0 && settledSat < SWEEP_MIN_SAT) {
    return (
      <QuietLine>
        {`${settledSat} sat settled at the mint; it sweeps to your wallet once the till reaches ${SWEEP_MIN_SAT} sat.`}
      </QuietLine>
    );
  }
  return (
    <Banner>
      <BannerText>
        ⚠ {queueSat + settledSat} sat in the till
        {settledSat >= SWEEP_MIN_SAT ? ` (${settledSat} sat to sweep)` : ''}
      </BannerText>
      <BannerSub>
        {queueCount > 0
          ? `${queueCount} tapped payment(s) settle automatically when online. `
          : ''}
        {settledSat > 0
          ? settledSat < SWEEP_MIN_SAT
            ? `${settledSat} sat settled at the mint; it sweeps to your wallet once the till reaches ${SWEEP_MIN_SAT} sat. `
            : `${settledSat} sat settled at the mint; it sweeps to your wallet when online. `
          : ''}
        {failedCount > 0
          ? `${failedCount} settlement(s) failed (${failedSat} sat) — Settle now retries them.`
          : ''}
      </BannerSub>
      {payoutError ? (
        <PayoutError>Payout blocked by the mint: {payoutError}</PayoutError>
      ) : null}
      <BtnRow>
        <SettleBtn onPress={settleNow} disabled={settling}>
          <SettleText>{settling ? 'Settling…' : 'Settle now'}</SettleText>
        </SettleBtn>
        {failedCount > 0 && (
          <DismissBtn onPress={dismissFailed} disabled={settling}>
            <DismissText>Settled elsewhere</DismissText>
          </DismissBtn>
        )}
      </BtnRow>
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

const QuietLine = styled.Text`
  font-size: 12px;
  font-family: 'Outfit-Regular';
  color: #6b7280;
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

const PayoutError = styled.Text`
  font-size: 12px;
  font-family: 'Outfit-SemiBold';
  color: #b91c1c;
  margin-top: 6px;
`;

const SettleBtn = styled.TouchableOpacity`
  margin-top: 10px;
  background-color: #d97706;
  border-radius: 6px;
  padding-vertical: 6px;
  padding-horizontal: 14px;
`;

const BtnRow = styled.View`
  margin-top: 10px;
  flex-direction: row;
  gap: 10px;
`;

const DismissBtn = styled.TouchableOpacity`
  background-color: #fef3c7;
  border-width: 1px;
  border-color: #d97706;
  border-radius: 6px;
  padding-vertical: 6px;
  padding-horizontal: 14px;
`;

const DismissText = styled.Text`
  font-size: 12px;
  font-family: 'Outfit-SemiBold';
  color: #92400e;
`;

const SettleText = styled.Text`
  font-size: 12px;
  font-family: 'Outfit-SemiBold';
  color: #ffffff;
`;
