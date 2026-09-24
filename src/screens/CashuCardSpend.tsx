import React, {useCallback, useEffect, useRef, useState} from 'react';
import {ActivityIndicator, ScrollView, TextInput} from 'react-native';
import styled from 'styled-components/native';

// components
// Imported from the leaf, not the `../components` barrel — same reasoning as
// CashuCardDebug: a dev NFC harness needs neither the printer nor the
// currency-picker native modules.
import TextButton from '../components/buttons/TextButton';

// services
import {
  cancelCardSession,
  describeCardFailure,
  isUserCancel,
  isCardReadingSupported,
  withCardSession,
} from '../services/cashuCardNfc';
import {useAppSelector} from '../store/hooks';
import {readCard, type CardSummary} from '../services/cashuCard';
import {runAutoSettlement} from '../services/cashuAutoSettle';
import {burnAndRecord, firstUnspentSlot, settlePending} from '../services/cashuSpend';
import {
  meltSettledProofs,
  type PayoutResult,
} from '../services/cashuMint';
import {chargeCard, type ChargeResult} from '../services/cashuCharge';
import {
  listSettlements,
  type DrainResult,
  type SettlementEntry,
} from '../services/cashuSettlement';
import {FLASH_CASHU_MINT_URL} from '@env';

const contentStyle = {padding: 20};
const readButtonStyle = {marginTop: 24, marginBottom: 8};
const cancelButtonStyle = {marginTop: 4, marginBottom: 8};
const settleButtonStyle = {marginTop: 16};
const detailLabelStyle = {marginTop: 12};

const PayoutInput = styled(TextInput)`
  margin-top: 8px;
  border-width: 1px;
  border-color: #ececf1;
  border-radius: 8px;
  padding: 10px;
  font-size: 13px;
  color: #1f2328;
`;

interface SpendOutcome {
  summary: CardSummary;
  entry: SettlementEntry;
}

interface ChargeOutcome {
  result: ChargeResult;
}

/**
 * Cashu card spend screen (dev builds only) — the terminal's first
 * tap-to-settle path, wired to the offline settlement queue.
 *
 * One tap burns the first unspent slot and records the settlement; the mint
 * round-trip happens *outside* the NFC session, on the Settle control. The
 * queue is the production one (`recordSpend` → `drainQueue` with the cashu-ts
 * adapter), so this screen is the silicon proof of the whole spend path.
 *
 * CashuCardDebug is the read-only bring-up harness; this one moves money.
 */
const CashuCardSpend = () => {
  const {username} = useAppSelector(state => state.user);
  const [supported, setSupported] = useState<boolean | null>(null);
  const [spending, setSpending] = useState(false);
  const [settling, setSettling] = useState(false);
  const [outcome, setOutcome] = useState<SpendOutcome | null>(null);
  const [drain, setDrain] = useState<DrainResult | null>(null);
  const [queue, setQueue] = useState<SettlementEntry[] | null>(null);
  const [payoutInput, setPayoutInput] = useState('');
  const [payingOut, setPayingOut] = useState(false);
  const [payout, setPayout] = useState<PayoutResult | null>(null);
  const [chargeAmount, setChargeAmount] = useState('');
  const [chargePin, setChargePin] = useState('');
  const [charging, setCharging] = useState(false);
  const [charge, setCharge] = useState<ChargeResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshQueue = useCallback(async () => {
    try {
      setQueue(await listSettlements());
    } catch {
      setQueue(null);
    }
  }, []);

  // `spending` drives the UI; the ref is what `onSpend` reads, so the guard is
  // correct even for two presses inside a single render tick.
  const spendingRef = useRef(false);
  const cancelledRef = useRef(false);

  useEffect(() => {
    isCardReadingSupported().then(setSupported);
    // The queue outlives this process; surface it so exposure and failure
    // detail are visible without a Mac attached.
    refreshQueue();
  }, [refreshQueue]);

  // A pending IsoDep request swallows every BoltCard tap app-wide (see
  // docs/13-cashu-card.md) — leaving this screen mid-read must cancel it.
  useEffect(
    () => () => {
      cancelledRef.current = true;
      cancelCardSession();
    },
    [],
  );

  const onCharge = useCallback(async () => {
    const amount = Number(chargeAmount);
    if (spendingRef.current || !amount || amount <= 0 || !chargePin) {
      return;
    }
    spendingRef.current = true;
    cancelledRef.current = false;
    setCharging(true);
    setError(null);
    setCharge(null);
    setDrain(null);
    try {
      const result = await withCardSession(transceive =>
        chargeCard({
          transceive,
          amountSat: amount,
          pin: chargePin,
          mintUrl: FLASH_CASHU_MINT_URL,
        }), {
        alertMessage: `Charge ${amount} sat — hold the customer's card`,
      });
      setCharge(result);
      await refreshQueue();
      // The burns are recorded; settle + sweep to the account address now.
      // Runs after the NFC session is closed; a failed auto-run is the
      // offline case — queue holds, banner shows.
      if (username) {
        await runAutoSettlement(username).catch(() => {});
        await refreshQueue();
      }
    } catch (err) {
      // Same double cancel-catch as CashuCardDebug: the ref catches our own
      // button; `isUserCancel` catches the iOS system sheet.
      if (!cancelledRef.current && !isUserCancel(err)) {
        setError(describeCardFailure(err));
      }
    } finally {
      spendingRef.current = false;
      setCharging(false);
    }
  }, [chargeAmount, chargePin, refreshQueue, username]);

  const onSettle = useCallback(async () => {
    setSettling(true);
    setError(null);
    try {
      setDrain(await settlePending());
      await refreshQueue();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSettling(false);
    }
  }, [refreshQueue]);

  // A lightning address (user@host) resolves via LNURL-pay; anything that
  // looks like a bolt11 is quoted as-is. The melt pays whoever the invoice
  // names — the mint is indifferent.
  const onPayout = useCallback(async () => {
    const value = payoutInput.trim();
    if (!value || payingOut) {
      return;
    }
    setPayingOut(true);
    setError(null);
    setPayout(null);
    try {
      const isInvoice = /^lnb[ct]/i.test(value);
      const result = await meltSettledProofs({
        mintUrl: FLASH_CASHU_MINT_URL,
        ...(isInvoice ? {bolt11: value} : {lightningAddress: value}),
      });
      setPayout(result);
      await refreshQueue();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPayingOut(false);
    }
  }, [payoutInput, payingOut, refreshQueue]);

  const onCancel = useCallback(() => {
    cancelledRef.current = true;
    cancelCardSession();
  }, []);

  return (
    <Wrapper contentContainerStyle={contentStyle}>
      <Title>Cashu card spend</Title>
      <Caption>
        Burns the first unspent slot and queues the settlement. Mint:{' '}
        {FLASH_CASHU_MINT_URL}
      </Caption>

      <Row>
        <Label>NFC available</Label>
        <Value>
          {supported === null ? 'checking…' : supported ? 'yes' : 'no'}
        </Value>
      </Row>

      <Results>
        <Label style={detailLabelStyle}>Charge amount (sat)</Label>
        <PayoutInput
          value={chargeAmount}
          onChangeText={setChargeAmount}
          placeholder="e.g. 21"
          keyboardType="number-pad"
        />
        <Label style={detailLabelStyle}>Customer PIN</Label>
        <PayoutInput
          value={chargePin}
          onChangeText={setChargePin}
          placeholder="customer's card PIN"
          secureTextEntry
          keyboardType="number-pad"
        />
        <TextButton
          icon="wifi"
          title={charging ? 'Waiting for tap…' : 'Charge card'}
          btnStyle={readButtonStyle}
          disabled={charging || !chargeAmount || !chargePin}
          onPress={onCharge}
        />
      </Results>
      {spending && (
        <>
          <ActivityIndicator />
          <TextButton
            icon="xmark"
            title="Cancel read"
            btnStyle={cancelButtonStyle}
            onPress={onCancel}
          />
        </>
      )}

      {/* Drain is offered regardless of the burn outcome: the queue persists
          across restarts, so a burn from a previous session is settled here. */}
      <TextButton
        title={settling ? 'Settling…' : 'Settle now (network)'}
        btnStyle={settleButtonStyle}
        disabled={settling}
        onPress={onSettle}
      />
      {settling && <ActivityIndicator style={settleButtonStyle} />}

      {error && (
        <ErrorBox>
          <ErrorText>{error}</ErrorText>
        </ErrorBox>
      )}

      {charge && (
        <Results>
          <Row>
            <Label>Charged</Label>
            <Value>{charge.amountSat} sat</Value>
          </Row>
          <Row>
            <Label>Proofs burned</Label>
            <Value>{charge.burned.length}</Value>
          </Row>
          {charge.changeSat > 0 && (
            <Row>
              <Label>Change written to card</Label>
              <Value>
                {charge.changeSat} sat ({charge.changeLoaded}{' '}
                proof(s))
              </Value>
            </Row>
          )}
          <Row>
            <Label>Card balance after</Label>
            <Value>{charge.balanceAfter}</Value>
          </Row>
        </Results>
      )}

      {drain && (
        <Results>
          <Row>
            <Label>Drain result</Label>
            <Value>
              settled {drain.settled} · pending {drain.stillPending} · failed{' '}
              {drain.failed} · lost {drain.lost}
            </Value>
          </Row>
        </Results>
      )}

      {queue && queue.length > 0 && (
        <Results>
          <Label style={detailLabelStyle}>Settlement queue</Label>
          {queue.map(e => (
            <Row key={e.id}>
              <Label>
                slot {e.slot} · {e.amount} {e.unit} · {e.status}
                {e.attempts ? ` · tries ${e.attempts}` : ''}
                {e.lastError ? ` · ${e.lastError}` : ''}
              </Label>
            </Row>
          ))}
        </Results>
      )}

      {payout && (
        <Results>
          <Row>
            <Label>Paid out</Label>
            <Value>
              {payout.paidSat} sat · reserve {payout.feeReserveSat} sat
            </Value>
          </Row>
          {payout.preimage && (
            <Row>
              <Label>Preimage</Label>
              <Mono>{payout.preimage}</Mono>
            </Row>
          )}
        </Results>
      )}

      <Results>
        <Label style={detailLabelStyle}>Pay out settled proofs</Label>
        <PayoutInput
          value={payoutInput}
          onChangeText={setPayoutInput}
          placeholder="lightning address or bolt11 invoice"
          autoCapitalize="none"
          autoCorrect={false}
          multiline
        />
        <TextButton
          title={payingOut ? 'Paying out…' : 'Pay out via Lightning'}
          btnStyle={settleButtonStyle}
          disabled={payingOut || payoutInput.trim().length === 0}
          onPress={onPayout}
        />
        {payingOut && <ActivityIndicator style={detailLabelStyle} />}
      </Results>
    </Wrapper>
  );
};

export default CashuCardSpend;

const Wrapper = styled(ScrollView)`
  flex: 1;
  background-color: #ffffff;
`;

const Title = styled.Text`
  font-size: 20px;
  font-family: 'Outfit-SemiBold';
  color: #1f2328;
`;

const Caption = styled.Text`
  font-size: 13px;
  font-family: 'Outfit-Regular';
  color: #7a7a8c;
  margin-top: 6px;
  margin-bottom: 16px;
`;

const Row = styled.View`
  flex-direction: row;
  justify-content: space-between;
  padding-top: 8px;
  padding-bottom: 8px;
  border-bottom-width: 1px;
  border-bottom-color: #ececf1;
`;

const Label = styled.Text`
  font-size: 14px;
  font-family: 'Outfit-Regular';
  color: #7a7a8c;
`;

const Value = styled.Text`
  font-size: 14px;
  font-family: 'Outfit-SemiBold';
  color: #1f2328;
`;

const Results = styled.View`
  margin-top: 8px;
`;

const Mono = styled.Text`
  font-size: 12px;
  font-family: 'Menlo';
  color: #1f2328;
  margin-top: 4px;
`;

const ErrorBox = styled.View`
  background-color: #fdf0ef;
  border-radius: 8px;
  padding: 12px;
  margin-top: 8px;
`;

const ErrorText = styled.Text`
  font-size: 13px;
  font-family: 'Outfit-Regular';
  color: #b3261e;
`;
