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
    const run = () => {
      // One run per foreground event; a tap can also start one, and
      // runAutoSettlement collapses concurrent calls into the first.
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
          })
          .catch(() => {
            // Drain-level failure: the queue holds the entries and the
            // pending-settlement banner carries the visibility.
          });
      }
    };
    const appState = AppState.addEventListener('change', state => {
      if (state === 'active') {
        run();
      }
    });
    run();
    return () => appState.remove();
  }, []);

  return null;
};

export default CashuAutoSettle;
