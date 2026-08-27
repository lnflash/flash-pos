import React, {useCallback, useEffect, useState} from 'react';
import {ActivityIndicator, ScrollView} from 'react-native';
import styled from 'styled-components/native';

// components
import {TextButton} from '../components';

// services
import {
  describeCardFailure,
  isCardReadingSupported,
  readCardOverNfc,
} from '../services/cashuCardNfc';
import type {CardSummary} from '../services/cashuCard';

const contentStyle = {padding: 20};
const readButtonStyle = {marginTop: 24, marginBottom: 16};
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

  useEffect(() => {
    isCardReadingSupported().then(setSupported);
  }, []);

  const onRead = useCallback(async () => {
    setReading(true);
    setError(null);
    setSummary(null);
    try {
      setSummary(await readCardOverNfc({alertMessage: 'Hold the Cashu card to the phone'}));
    } catch (err) {
      setError(describeCardFailure(err));
    } finally {
      setReading(false);
    }
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
        onPress={onRead}
      />
      {reading && <ActivityIndicator />}

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
