import {renderHook} from '@testing-library/react-native';

import {useCardSessionRelease} from '../../src/hooks/useCardSessionRelease';
import {navigationStub} from '../support/navigationStub';

const mockCancelCardSession = jest.fn();

jest.mock('../../src/services/cashuCardNfc', () => ({
  cancelCardSession: (...args: unknown[]) => mockCancelCardSession(...args),
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockCancelCardSession.mockResolvedValue(undefined);
});

describe('useCardSessionRelease (ENG-704)', () => {
  it('cancels as the stack lets the screen go, and not again at unmount', () => {
    // The unmount lands at the end of the close transition, when the keypad
    // underneath has re-armed and may be mid-read: a second cancel there
    // would close the keypad's tag, not ours.
    const navigation = navigationStub();
    const {unmount} = renderHook(() => useCardSessionRelease({navigation}));

    expect(mockCancelCardSession).not.toHaveBeenCalled();
    expect(navigation.emitBeforeRemove()).toBe(false);
    expect(mockCancelCardSession).toHaveBeenCalledTimes(1);

    unmount();
    expect(mockCancelCardSession).toHaveBeenCalledTimes(1);
  });

  it('still cancels at unmount when the screen leaves without a beforeRemove', () => {
    const {unmount} = renderHook(() =>
      useCardSessionRelease({navigation: navigationStub()}),
    );
    unmount();
    expect(mockCancelCardSession).toHaveBeenCalledTimes(1);
  });

  it("marks the cut as the screen's own before cancelling", () => {
    const order: string[] = [];
    mockCancelCardSession.mockImplementation(async () => {
      order.push('cancel');
    });
    const navigation = navigationStub();
    renderHook(() =>
      useCardSessionRelease({
        navigation,
        onRelease: () => order.push('onRelease'),
      }),
    );
    navigation.emitBeforeRemove();
    expect(order).toEqual(['onRelease', 'cancel']);
  });

  it('without a navigation, hands release to the screen and installs no listener', () => {
    const {result, unmount} = renderHook(() => useCardSessionRelease());

    result.current();
    expect(mockCancelCardSession).toHaveBeenCalledTimes(1);

    unmount();
    expect(mockCancelCardSession).toHaveBeenCalledTimes(1);
  });

  it('stops listening once unmounted', () => {
    const navigation = navigationStub();
    const {unmount} = renderHook(() => useCardSessionRelease({navigation}));
    unmount();
    mockCancelCardSession.mockClear();

    navigation.emitBeforeRemove();
    expect(mockCancelCardSession).not.toHaveBeenCalled();
  });
});
