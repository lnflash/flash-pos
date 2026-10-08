import React, {useContext} from 'react';
import {act, render} from '@testing-library/react-native';
import {
  FlashcardContext,
  FlashcardProvider,
} from '../../src/contexts/Flashcard';

// The real routes module pulls in every screen; the provider only needs the
// navigation ref for the tap-to-navigate path, which these tests never hit.
jest.mock('../../src/routes', () => ({
  navigationRef: {isReady: () => false, navigate: jest.fn()},
}));

jest.mock('../../src/contexts/ActivityIndicator', () => ({
  ActivityIndicator: () => null,
}));

type ContextValue = React.ContextType<typeof FlashcardContext>;

describe('FlashcardProvider value identity (ENG-627)', () => {
  // Every context value the provider has handed out, in render order.
  const captured: ContextValue[] = [];

  const Consumer = () => {
    captured.push(useContext(FlashcardContext));
    return null;
  };

  const tree = (label: string) => (
    <FlashcardProvider>
      <Consumer key={label} />
    </FlashcardProvider>
  );

  beforeEach(() => {
    captured.length = 0;
  });

  it('keeps the same function references across a provider re-render', () => {
    const {rerender} = render(tree('a'));
    expect(captured).toHaveLength(1);

    // A new element forces the provider itself to render again.
    rerender(tree('a'));
    expect(captured.length).toBeGreaterThanOrEqual(2);

    const first = captured[0];
    const last = captured[captured.length - 1];

    // Invoice's payUsingFlashcard lists resetFlashcard in its deps and is
    // driven by useFocusEffect; a fresh identity here re-sends the withdraw
    // callback.
    expect(last.resetFlashcard).toBe(first.resetFlashcard);
    expect(last.handleTag).toBe(first.handleTag);
    expect(last.setNfcEnabled).toBe(first.setNfcEnabled);
    expect(last.setNfcBusy).toBe(first.setNfcBusy);
    expect(last.getAllStoredCards).toBe(first.getAllStoredCards);
    expect(last.deleteStoredCard).toBe(first.deleteStoredCard);
    expect(last.clearAllStoredCards).toBe(first.clearAllStoredCards);
    expect(last.getCardRewardLnurl).toBe(first.getCardRewardLnurl);
    // Nothing changed, so the memoized value object is the same one too.
    expect(last).toBe(first);
  });

  it('keeps function references when provider state changes', () => {
    render(tree('a'));
    const first = captured[0];

    act(() => {
      first.setNfcEnabled(false);
    });

    const last = captured[captured.length - 1];
    expect(last).not.toBe(first);
    expect(last.isNfcEnabled).toBe(false);
    expect(last.resetFlashcard).toBe(first.resetFlashcard);
    expect(last.handleTag).toBe(first.handleTag);
    expect(last.getAllStoredCards).toBe(first.getAllStoredCards);
  });

  it('resetFlashcard clears the card without changing its own identity', () => {
    render(tree('a'));
    const first = captured[0];

    act(() => {
      first.resetFlashcard();
    });

    const last = captured[captured.length - 1];
    expect(last.k1).toBeUndefined();
    expect(last.tag).toBeUndefined();
    expect(last.lnurl).toBeUndefined();
    expect(last.resetFlashcard).toBe(first.resetFlashcard);
  });
});
