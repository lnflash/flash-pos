import React, {useCallback, useEffect, useRef, useState} from 'react';
import {ActivityIndicator, ScrollView} from 'react-native';
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
import {readCard, type CardSummary} from '../services/cashuCard';
import {burnAndRecord, firstUnspentSlot, settlePending} from '../services/cashuSpend';
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

interface SpendOutcome {
  summary: CardSummary;
  entry: SettlementEntry;
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
  const [supported, setSupported] = useState<boolean | null>(null);
  const [spending, setSpending] = useState(false);
  const [settling, setSettling] = useState(false);
  const [outcome, setOutcome] = useState<SpendOutcome | null>(null);
  const [drain, setDrain] = useState<DrainResult | null>(null);
  const [queue, setQueue] = useState<SettlementEntry[] | null>(null);
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

  const onSpend = useCallback(async () => {
    if (spendingRef.current) {
      return;
    }
    spendingRef.current = true;
    cancelledRef.current = false;
    setSpending(true);
    setError(null);
    setOutcome(null);
    setDrain(null);
    try {
      const result = await withCardSession(async transceive => {
        // One session, card work only — the drain is a network round trip and
        // runs after the field is released.
        const summary = await readCard(transceive);
        const proof = await firstUnspentSlot(transceive, summary.info.maxSlots);
        if (!proof) {
          throw new Error('the card has no unspent slot');
        }
        const entry = await burnAndRecord({
          transceive,
          slot: proof.slot,
          mintUrl: FLASH_CASHU_MINT_URL,
        });
        return {summary, entry};
      }, {
        alertMessage: 'Hold the Cashu card to the phone',
      });
      setOutcome(result);
      await refreshQueue();
    } catch (err) {
      // Same double cancel-catch as CashuCardDebug: the ref catches our own
      // button; `isUserCancel` catches the iOS system sheet.
      if (!cancelledRef.current && !isUserCancel(err)) {
        setError(describeCardFailure(err));
      }
    } finally {
      spendingRef.current = false;
      setSpending(false);
    }
  }, []);

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
  }, []);

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

      <TextButton
        icon="wifi"
        title={spending ? 'Waiting for tap…' : 'Tap card & spend first unspent slot'}
        btnStyle={readButtonStyle}
        disabled={spending}
        onPress={onSpend}
      />
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

      {outcome && (
        <Results>
          <Row>
            <Label>Card balance after burn</Label>
            <Value>{outcome.summary.balance}</Value>
          </Row>
          <Row>
            <Label>Queued</Label>
            <Value>
              slot {outcome.entry.slot} · {outcome.entry.amount}{' '}
              {outcome.entry.unit} · {outcome.entry.status}
            </Value>
          </Row>
          <Label style={detailLabelStyle}>Settlement id</Label>
          <Mono selectable>{outcome.entry.id}</Mono>
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
