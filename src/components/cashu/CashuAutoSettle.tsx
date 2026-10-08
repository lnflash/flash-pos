import {useEffect, useRef} from 'react';
import {AppState} from 'react-native';

import {useAppSelector} from '../../store/hooks';
import {toastShow} from '../../utils/toast';
import {
  AUTO_SETTLE_BASELINE_MS,
  autoSettleInFlight,
  nextAutoSettleDelay,
  payoutToast,
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
    // The cadence policy (baseline, backoff, cap) is nextAutoSettleDelay;
    // this effect only owns the timer.
    let delay = AUTO_SETTLE_BASELINE_MS;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const attempt = () => {
      // One run per tick; a tap can also start one, and runAutoSettlement
      // collapses concurrent calls into the first.
      if (!autoSettleInFlight() && usernameRef.current) {
        runAutoSettlement(usernameRef.current)
          .then(result => {
            // Both policies live in the service: what to tell the merchant
            // (payoutToast) and when to run next (nextAutoSettleDelay).
            const toast = payoutToast(result);
            if (toast) {
              toastShow(toast);
            }
            delay = nextAutoSettleDelay(delay, result);
          })
          .catch(() => {
            delay = nextAutoSettleDelay(delay, null);
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
