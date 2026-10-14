import {useCallback, useEffect, useRef} from 'react';

import {cancelCardSession} from '../services/cashuCardNfc';

/** The one navigator event this hook listens on. */
export interface BeforeRemoveSource {
  addListener(type: 'beforeRemove', callback: () => void): () => void;
}

export interface CardSessionReleaseOptions {
  /**
   * Installs a `beforeRemove` listener that releases the session as soon as
   * the stack lets this screen go. Leave it out when the screen has its own
   * `beforeRemove` listener that may refuse the removal, and call the
   * returned `release` from that listener's let-through branches instead.
   */
  navigation?: BeforeRemoveSource | null;
  /** Runs inside `release`, before the cancel: mark the cut as the screen's own. */
  onRelease?: () => void;
}

/**
 * Ends a card screen's IsoDep request when the screen leaves, not after.
 *
 * A pending request swallows every BoltCard tap app-wide, so every card
 * screen must cancel it on the way out. An unmount cleanup alone runs too
 * late: the stack unmounts a popped screen at the END of its close
 * transition (about 350 to 400 ms), and by then the screen underneath has
 * focus. When that is the keypad, it has armed its own request and a card
 * may already be mid-read; `cancelCardSession` cancels whatever is pending,
 * which closes the keypad's tag under its transceive and toasts a card
 * failure (ENG-704).
 *
 * `release` cancels at the source instead: from `beforeRemove`, before the
 * screen underneath is focused, so the next screen arms against a clear
 * radio. Once released, the unmount cleanup does nothing: whatever is
 * pending by then belongs to the next screen. A screen removed without a
 * `beforeRemove` (a parent unmounting, a test) still cancels on unmount.
 *
 * Returns `release`, stable across renders.
 */
export function useCardSessionRelease({
  navigation,
  onRelease,
}: CardSessionReleaseOptions = {}): () => void {
  const releasedRef = useRef(false);
  const onReleaseRef = useRef(onRelease);
  onReleaseRef.current = onRelease;

  const release = useCallback(() => {
    releasedRef.current = true;
    onReleaseRef.current?.();
    cancelCardSession();
  }, []);

  useEffect(() => {
    if (!navigation) {
      return;
    }
    return navigation.addListener('beforeRemove', release);
  }, [navigation, release]);

  useEffect(
    () => () => {
      if (!releasedRef.current) {
        cancelCardSession();
      }
    },
    [],
  );

  return release;
}
