/**
 * A stack-screen `navigation` prop with a working `beforeRemove` channel,
 * for screens that release their card session as the stack lets them go
 * (ENG-704). `emitBeforeRemove()` fires the event as a pop does and says
 * whether any listener refused it.
 */
type BeforeRemoveEvent = {
  preventDefault: () => void;
  data: {action: {type: string}};
};
type BeforeRemoveListener = (e: BeforeRemoveEvent) => void;

export function navigationStub<T extends object>(extra: T = {} as T) {
  const listeners: BeforeRemoveListener[] = [];
  return {
    ...extra,
    addListener: jest.fn((event: string, cb: BeforeRemoveListener) => {
      if (event !== 'beforeRemove') {
        return () => {};
      }
      listeners.push(cb);
      return () => {
        const at = listeners.indexOf(cb);
        if (at >= 0) {
          listeners.splice(at, 1);
        }
      };
    }),
    /** Fires `beforeRemove` as the stack does for a pop; true = prevented. */
    emitBeforeRemove: (type = 'GO_BACK') => {
      let prevented = false;
      for (const cb of [...listeners]) {
        cb({preventDefault: () => (prevented = true), data: {action: {type}}});
      }
      return prevented;
    },
  };
}
