import {
  getApduTimings,
  nowMs,
  recordApdu,
  resetApduTimings,
  summarizeApduTimings,
} from '../../src/services/apduTiming';

beforeEach(() => resetApduTimings());

describe('apduTiming', () => {
  it('records samples in order and reset empties them', () => {
    recordApdu('SELECT', 61);
    recordApdu('GET_INFO', 58.4);
    expect(getApduTimings()).toEqual([
      {context: 'SELECT', ms: 61},
      {context: 'GET_INFO', ms: 58.4},
    ]);
    resetApduTimings();
    expect(getApduTimings()).toEqual([]);
  });

  it('nowMs is a non-decreasing clock', () => {
    const a = nowMs();
    const b = nowMs();
    expect(b).toBeGreaterThanOrEqual(a);
  });

  it('summarises per command with the median, not the mean', () => {
    const line = summarizeApduTimings([
      {context: 'SELECT', ms: 61},
      {context: 'SPEND_PROOF', ms: 700},
      {context: 'SPEND_PROOF', ms: 740},
      {context: 'SPEND_PROOF', ms: 3000},
    ]);
    // A mean would say 1480; one torn APDU must not drag the figure.
    expect(line).toBe(
      'SELECT 1× 61ms · SPEND_PROOF 3× med 740ms (700–3000) · 4 APDUs, 4501ms on the wire',
    );
  });

  it('takes the midpoint for an even number of samples', () => {
    const line = summarizeApduTimings([
      {context: 'SPEND_PROOF', ms: 700},
      {context: 'SPEND_PROOF', ms: 800},
    ]);
    expect(line).toContain('SPEND_PROOF 2× med 750ms (700–800)');
  });

  it('defaults to the live collector and says so when empty', () => {
    expect(summarizeApduTimings()).toBe('no APDUs sent');
    recordApdu('GET_BALANCE', 55);
    expect(summarizeApduTimings()).toBe(
      'GET_BALANCE 1× 55ms · 1 APDUs, 55ms on the wire',
    );
  });
});
