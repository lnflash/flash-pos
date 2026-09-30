import {act, renderHook} from '@testing-library/react-native';
import {
  STALL_MS,
  useStallTimer,
} from '../../../src/components/cashu/charge/useStallTimer';

beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
});

describe('useStallTimer', () => {
  it('fires after a quiet stretch and resets on the next phase', () => {
    const {result, rerender} = renderHook(
      ({seq, enabled}: {seq: number; enabled: boolean}) => useStallTimer(seq, enabled),
      {initialProps: {seq: 1, enabled: true}},
    );
    expect(result.current).toBe(false);
    act(() => jest.advanceTimersByTime(STALL_MS));
    expect(result.current).toBe(true);
    rerender({seq: 2, enabled: true});
    expect(result.current).toBe(false);
    act(() => jest.advanceTimersByTime(STALL_MS - 1));
    expect(result.current).toBe(false);
  });

  it('stays quiet while disabled (the mint orbit already says working)', () => {
    const {result, unmount} = renderHook(() => useStallTimer(3, false));
    act(() => jest.advanceTimersByTime(STALL_MS * 2));
    expect(result.current).toBe(false);
    unmount();
    expect(jest.getTimerCount()).toBe(0);
  });
});
