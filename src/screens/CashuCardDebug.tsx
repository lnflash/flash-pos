import React, {useCallback, useEffect, useRef, useState} from 'react';
import {ActivityIndicator, ScrollView} from 'react-native';
import styled from 'styled-components/native';

// components
// Imported from the leaf, not the `../components` barrel: the barrel pulls in
// the printer and currency-picker modules, which a dev NFC harness has no need
// of and which drag native modules into this screen's tests.
import TextButton from '../components/buttons/TextButton';

// services
import {
  cancelCardSession,
  describeCardFailure,
  isCardReadingSupported,
  readCardOverNfc,
} from '../services/cashuCardNfc';
import type {CardSummary} from '../services/cashuCard';

const contentStyle = {padding: 20};
const readButtonStyle = {marginTop: 24, marginBottom: 16};
const cancelButtonStyle = {marginTop: 12, marginBottom: 8};
const pubkeyLabelStyle = {marginTop: 12};

/**
 * Cashu NFC card bring-up screen (dev builds only).
 *
 * Drives the read-only round-trip against a physical cashu-javacard:
 * SELECT → GET_INFO → GET_PUBKEY → GET_BALANCE. Nothing here spends a proof or
 * writes to the card, so it is safe to run against a loaded card.
 *
 * This is the terminal-side equivalent of `cardctl selftest` in the
 * cashu-javacard repo. If this screen shows a pubkey, the applet is installed,
 * the AID selects over NFC, and the card's crypto is answering.
 */
const CashuCardDebug = () => {
  const [supported, setSupported] = useState<boolean | null>(null);
  const [reading, setReading] = useState(false);
  const [summary, setSummary] = useState<CardSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  // `reading` drives the UI; the ref is what `onRead` reads, so the guard is
  // correct even for two presses inside a single render tick.
  const readingRef = useRef(false);

  useEffect(() => {
    isCardReadingSupported().then(setSupported);
  }, []);

  // An IsoDep request never times out on Android — it stays pending until a
  // card arrives. Leaving this screen mid-read would strand it, and a pending
  // session swallows every BoltCard tap app-wide, on the live payment path.
  useEffect(
    () => () => {
      cancelCardSession();
    },
    [],
  );

  const onRead = useCallback(async () => {
    // A second requestTechnology rejects with ERR_MULTI_REQ, and its teardown
    // then cancels the first, still-pending session. Both reads would fail.
    if (readingRef.current) {
      return;
    }
    readingRef.current = true;
    setReading(true);
    setError(null);
    setSummary(null);
    try {
      setSummary(
        await readCardOverNfc({
          alertMessage: 'Hold the Cashu card to the phone',
        }),
      );
    } catch (err) {
      setError(describeCardFailure(err));
    } finally {
      readingRef.current = false;
      setReading(false);
    }
  }, []);

  // Ends the session without leaving the screen. `withCardSession`'s own
  // teardown cannot run until a tag arrives, so this is the only way out of a
  // read that was started by mistake.
  const onCancel = useCallback(() => {
    cancelCardSession();
  }, []);

  return (
    <Wrapper contentContainerStyle={contentStyle}>
      <Title>Cashu card bring-up</Title>
      <Caption>
        Read-only: SELECT → GET_INFO → GET_PUBKEY → GET_BALANCE. No proof is
        spent.
      </Caption>

      <Row>
        <Label>NFC available</Label>
        <Value>
          {supported === null ? 'checking…' : supported ? 'yes' : 'no'}
        </Value>
      </Row>

      <TextButton
        icon="wifi"
        title={reading ? 'Waiting for tap…' : 'Read card'}
        btnStyle={readButtonStyle}
        disabled={reading}
        onPress={onRead}
      />
      {reading && (
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

      {error && (
        <ErrorBox>
          <ErrorText>{error}</ErrorText>
        </ErrorBox>
      )}

      {summary && (
        <Results>
          <Row>
            <Label>Applet version</Label>
            <Value>{summary.appletVersion}</Value>
          </Row>
          <Row>
            <Label>Balance</Label>
            <Value>{summary.balance}</Value>
          </Row>
          <Row>
            <Label>Slots (unspent/spent/empty)</Label>
            <Value>
              {summary.info.unspent}/{summary.info.spent}/{summary.info.empty}
            </Value>
          </Row>
          <Row>
            <Label>Max slots</Label>
            <Value>{summary.info.maxSlots}</Value>
          </Row>
          <Row>
            <Label>secp256k1 native</Label>
            <Value>{summary.info.secp256k1Native ? 'yes' : 'no'}</Value>
          </Row>
          <Row>
            <Label>Schnorr</Label>
            <Value>{summary.info.schnorr ? 'yes' : 'no'}</Value>
          </Row>
          <Row>
            <Label>PIN state</Label>
            <Value>{summary.info.pinState}</Value>
          </Row>
          <Label style={pubkeyLabelStyle}>Public key</Label>
          <Mono selectable>{summary.pubkey}</Mono>
        </Results>
      )}
    </Wrapper>
  );
};

export default CashuCardDebug;

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
