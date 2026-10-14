import React, {useCallback, useEffect, useState} from 'react';
import styled from 'styled-components/native';

// services
import {
  REFUSAL_LOG_CAP,
  getRefusalCounts,
  getRefusalLog,
  type RefusalCounts,
  type RefusalEntry,
  type RefusalKind,
} from '../services/refusalLog';

// utils
import {formatSatAmount} from '../utils/satCurrency';

/** What each refusal is, in the operator's words. */
export const REFUSAL_LABEL: Record<RefusalKind, string> = {
  change_needs_mint: 'Needed change, mint offline',
  online_only: 'Card could only pay online',
};

/** "2026-10-14 09:05": local time, to the minute. */
const when = (at: number): string => {
  const d = new Date(at);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(
    d.getHours(),
  )}:${two(d.getMinutes())}`;
};

/**
 * Offline card refusals (ENG-701): how many charges this terminal refused
 * because the mint was out of reach, by kind, then the most recent ones with
 * the bill and the card's piece sizes. For the operator: in production
 * Settings, read-only, nothing leaves the device.
 */
const RefusalLog: React.FC = () => {
  const [counts, setCounts] = useState<RefusalCounts | null>(null);
  const [entries, setEntries] = useState<RefusalEntry[]>([]);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const [c, log] = await Promise.all([getRefusalCounts(), getRefusalLog()]);
      setCounts(c);
      setEntries(log);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <Scroll contentContainerStyle={scrollContent} testID="refusal-log">
      <Intro>
        Card charges this terminal refused while the mint was out of reach.
        Nothing was taken from the card in any of them.
      </Intro>
      {failed && <Note>The log could not be read.</Note>}
      {counts && (
        <Section>
          {(Object.keys(REFUSAL_LABEL) as RefusalKind[]).map(kind => (
            <Row key={kind} testID={`refusal-count-${kind}`}>
              <Key>{REFUSAL_LABEL[kind]}</Key>
              <Count>{counts[kind]}</Count>
            </Row>
          ))}
        </Section>
      )}
      <Heading>Recent (last {REFUSAL_LOG_CAP})</Heading>
      {counts && entries.length === 0 && <Note>No refusals yet.</Note>}
      {entries.map((e, i) => (
        <Entry key={`${e.at}-${i}`} testID="refusal-entry">
          <Key>
            {formatSatAmount(e.amountSat)} · {REFUSAL_LABEL[e.kind]}
          </Key>
          <Value>
            Card pieces:{' '}
            {e.cardPieces.length > 0 ? e.cardPieces.join(', ') : 'none'}
          </Value>
          <Value>{when(e.at)}</Value>
        </Entry>
      ))}
    </Scroll>
  );
};

export default RefusalLog;

const scrollContent = {padding: 16, paddingBottom: 48};

const Scroll = styled.ScrollView`
  flex: 1;
  background-color: #ffffff;
`;

const Intro = styled.Text`
  font-size: 14px;
  font-family: 'Outfit-Regular';
  color: #5a5a5a;
  line-height: 20px;
`;

const Section = styled.View`
  margin-top: 16px;
`;

const Row = styled.View`
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  background-color: #f2f2f4;
  border-radius: 12px;
  padding: 16px;
  margin-top: 8px;
`;

const Entry = styled.View`
  background-color: #f2f2f4;
  border-radius: 12px;
  padding: 12px 16px;
  margin-top: 8px;
`;

const Heading = styled.Text`
  font-size: 16px;
  font-family: 'Outfit-Bold';
  color: #000000;
  margin-top: 24px;
`;

const Key = styled.Text`
  font-size: 16px;
  font-family: 'Outfit-Medium';
  color: #000000;
  flex-shrink: 1;
`;

const Count = styled.Text`
  font-size: 18px;
  font-family: 'Outfit-Bold';
  color: #000000;
  margin-left: 12px;
`;

const Value = styled.Text`
  font-size: 14px;
  font-family: 'Outfit-Regular';
  color: #5a5a5a;
  margin-top: 2px;
`;

const Note = styled.Text`
  font-size: 14px;
  font-family: 'Outfit-Regular';
  color: #5a5a5a;
  margin-top: 12px;
`;
