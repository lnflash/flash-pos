/**
 * The offline refusal log screen (ENG-701): counts per kind, then the recent
 * refusals with the bill and the card's piece sizes.
 */
import React from 'react';
import {render, waitFor, within} from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import RefusalLog, {REFUSAL_LABEL} from '../../src/screens/RefusalLog';
import {REFUSAL_LOG_KEY, recordRefusal} from '../../src/services/refusalLog';

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe('RefusalLog', () => {
  it('shows zero counts and says there are none yet', async () => {
    const {getByTestId, getByText} = render(<RefusalLog />);
    await waitFor(() => expect(getByText('No refusals yet.')).toBeTruthy());
    expect(
      within(getByTestId('refusal-count-change_needs_mint')).getByText('0'),
    ).toBeTruthy();
    expect(
      within(getByTestId('refusal-count-change_needs_mint')).getByText(
        REFUSAL_LABEL.change_needs_mint,
      ),
    ).toBeTruthy();
    expect(
      within(getByTestId('refusal-count-online_only')).getByText('0'),
    ).toBeTruthy();
    expect(
      within(getByTestId('refusal-count-online_only')).getByText(
        REFUSAL_LABEL.online_only,
      ),
    ).toBeTruthy();
  });

  it('shows the counts per kind and each refusal, newest first, with the piece sizes', async () => {
    await recordRefusal('change_needs_mint', 3, [8], 1000);
    await recordRefusal('online_only', 16, [16, 4], 2000);
    await recordRefusal('change_needs_mint', 5, [8, 1], 3000);

    const {getAllByTestId, getByTestId, queryByText} = render(<RefusalLog />);
    await waitFor(() =>
      expect(getAllByTestId('refusal-entry')).toHaveLength(3),
    );

    expect(
      within(getByTestId('refusal-count-change_needs_mint')).getByText('2'),
    ).toBeTruthy();
    expect(
      within(getByTestId('refusal-count-change_needs_mint')).getByText(
        REFUSAL_LABEL.change_needs_mint,
      ),
    ).toBeTruthy();
    expect(
      within(getByTestId('refusal-count-online_only')).getByText('1'),
    ).toBeTruthy();
    expect(
      within(getByTestId('refusal-count-online_only')).getByText(
        REFUSAL_LABEL.online_only,
      ),
    ).toBeTruthy();
    const entries = getAllByTestId('refusal-entry');
    expect(
      within(entries[0]).getByText(/5 sats · Needed change, mint offline/),
    ).toBeTruthy();
    expect(within(entries[0]).getByText(/Card pieces: 8, 1/)).toBeTruthy();
    expect(
      within(entries[1]).getByText(/16 sats · Card could only pay online/),
    ).toBeTruthy();
    expect(within(entries[1]).getByText(/Card pieces: 16, 4/)).toBeTruthy();
    expect(within(entries[2]).getByText(/3 sats/)).toBeTruthy();
    expect(queryByText('No refusals yet.')).toBeNull();
  });

  it('a stored log that does not parse shows as empty, not as an error', async () => {
    await AsyncStorage.setItem(REFUSAL_LOG_KEY, '{broken');
    const {getByText, queryByText} = render(<RefusalLog />);
    await waitFor(() => expect(getByText('No refusals yet.')).toBeTruthy());
    expect(queryByText('The log could not be read.')).toBeNull();
  });

  it('says so when the log cannot be read at all', async () => {
    (AsyncStorage.getItem as jest.Mock).mockImplementationOnce(async () => {
      throw new Error('storage gone');
    });
    const {getByText} = render(<RefusalLog />);
    await waitFor(() =>
      expect(getByText('The log could not be read.')).toBeTruthy(),
    );
  });
});

describe('the RefusalLog route (src/routes/index.tsx)', () => {
  it('is registered outside every __DEV__ block, like the Settings row', () => {
    const fs = require('fs');
    const path = require('path');
    const text: string = fs.readFileSync(
      path.join(__dirname, '../../src/routes/index.tsx'),
      'utf8',
    );
    const at = text.indexOf('name="RefusalLog"');
    expect(at).toBeGreaterThan(-1);
    // The JSX between the previous screen's end and this one opens no
    // __DEV__ block.
    const before = text.slice(0, at);
    const start = before.lastIndexOf('<Stack.Screen');
    const previousEnd = Math.max(
      before.lastIndexOf('/>', start),
      before.lastIndexOf(')}', start),
    );
    expect(text.slice(previousEnd, start)).not.toMatch(/__DEV__\s*&&/);
  });
});
