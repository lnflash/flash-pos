import {useEffect, useRef} from 'react';
import {AppState} from 'react-native';

import {useAppSelector} from '../../store/hooks';
import {toastShow} from '../../utils/toast';
import {
  autoSettleInFlight,
  runAutoSettlement,
} from '../../services/cashuAutoSettle';

/**
 * App-level controller: runs the settle-then-sweep pipeline whenever the app
 * comes to the foreground. A completed tap also triggers it directly (see
 * CashuCardSpend), so the only gap this closes is value that aged while the
 * device was away or offline — exactly the "back online" moment.
 *
 * Renders nothing.
 */
const CashuAutoSettle = () => {
  const {username} = useAppSelector(state => state.user);
  // Redux rehydration can land after mount; keep the latest username without
  // re-subscribing the AppState listener for every store write.
  const usernameRef = useRef(username);
  useEffect(() => {
    usernameRef.current = username;
  }, [username]);

  useEffect(() => {
    // Forge's limiter sustains its block under steady pressure: a fixed
    // cadence re-arms it every tick and a throttled settlement never clears.
    // The retry loop therefore backs off while runs come back incomplete and
    // snaps back to the fast baseline once a run lands clean.
    const BASELINE_MS = 20000;
    const MAX_MS = 240000;
    let delay = BASELINE_MS;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const attempt = () => {
      // One run per tick; a tap can also start one, and runAutoSettlement
      // collapses concurrent calls into the first.
      if (!autoSettleInFlight() && usernameRef.current) {
        runAutoSettlement(usernameRef.current)
          .then(result => {
            if (result.paidSat != null && result.paidSat > 0) {
              toastShow({
                message: `Cashu: paid out ${result.paidSat} sat to your wallet`,
                type: 'success',
              });
            } else if (result.payoutError) {
              toastShow({
                message: `Cashu payout pending: ${result.payoutError}`,
                type: 'error',
              });
            }
            if (result.stillPending > 0 || result.payoutError) {
              delay = Math.min(delay * 2, MAX_MS);
            } else {
              delay = BASELINE_MS;
            }
          })
          .catch(() => {
            delay = Math.min(delay * 2, MAX_MS);
          });
      }
    };
    const run = () => {
      attempt();
      timer = setTimeout(run, delay);
    };
    const appState = AppState.addEventListener('change', state => {
      if (state === 'active') {
        attempt();
      }
    });
    run();
    return () => {
      appState.remove();
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, []);

  return null;
};

export default CashuAutoSettle;
