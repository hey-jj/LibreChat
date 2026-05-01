jest.mock('~/data-provider', () => ({
  useGetEndpointsQuery: jest.fn(),
}));

jest.mock('librechat-data-provider/react-query', () => ({
  useUserKeyQuery: jest.fn(),
  useUpdateUserKeysMutation: jest.fn(),
}));

import { renderHook } from '@testing-library/react';
import useUserKey from './useUserKey';
import { useGetEndpointsQuery } from '~/data-provider';
import { useUserKeyQuery, useUpdateUserKeysMutation } from 'librechat-data-provider/react-query';

describe('useUserKey', () => {
  const ONE_MINUTE_MS = 60_000;
  const mutate = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    (useGetEndpointsQuery as jest.Mock).mockReturnValue({ data: {} });
    (useUpdateUserKeysMutation as jest.Mock).mockReturnValue({ mutate });
  });

  it('treats a missing key as missing instead of never-expiring', () => {
    (useUserKeyQuery as jest.Mock).mockReturnValue({ data: { expiresAt: null } });

    const { result } = renderHook(() => useUserKey('openAI'));

    expect(result.current.getExpiry()).toBeUndefined();
    expect(result.current.hasKey).toBe(false);
    expect(result.current.isKeyValid).toBe(false);
    expect(result.current.keyStatus).toBe('missing');
    expect(result.current.checkExpiry()).toBe(false);
  });

  it('treats a never-expiring key as valid', () => {
    (useUserKeyQuery as jest.Mock).mockReturnValue({ data: { expiresAt: 'never' } });

    const { result } = renderHook(() => useUserKey('openAI'));

    expect(result.current.getExpiry()).toBe('never');
    expect(result.current.hasKey).toBe(true);
    expect(result.current.isKeyValid).toBe(true);
    expect(result.current.keyStatus).toBe('valid');
    expect(result.current.checkExpiry()).toBe(true);
  });

  it('drops back to missing when a never-expiring key is revoked', () => {
    (useUserKeyQuery as jest.Mock)
      .mockReturnValueOnce({ data: { expiresAt: 'never' } })
      .mockReturnValueOnce({ data: { expiresAt: null } });

    const { result, rerender } = renderHook(() => useUserKey('openAI'));

    expect(result.current.getExpiry()).toBe('never');
    expect(result.current.hasKey).toBe(true);
    expect(result.current.isKeyValid).toBe(true);
    expect(result.current.keyStatus).toBe('valid');
    expect(result.current.checkExpiry()).toBe(true);

    rerender();

    expect(result.current.getExpiry()).toBeUndefined();
    expect(result.current.hasKey).toBe(false);
    expect(result.current.isKeyValid).toBe(false);
    expect(result.current.keyStatus).toBe('missing');
    expect(result.current.checkExpiry()).toBe(false);
  });

  it('treats a future-dated key as valid', () => {
    const expiresAt = new Date(Date.now() + ONE_MINUTE_MS).toISOString();
    (useUserKeyQuery as jest.Mock).mockReturnValue({ data: { expiresAt } });

    const { result } = renderHook(() => useUserKey('openAI'));

    expect(result.current.getExpiry()).toBe(expiresAt);
    expect(result.current.hasKey).toBe(true);
    expect(result.current.isKeyValid).toBe(true);
    expect(result.current.keyStatus).toBe('valid');
    expect(result.current.checkExpiry()).toBe(true);
  });

  it('keeps an expired key present but invalid', () => {
    const expiredAt = new Date(Date.now() - ONE_MINUTE_MS).toISOString();
    (useUserKeyQuery as jest.Mock).mockReturnValue({ data: { expiresAt: expiredAt } });

    const { result } = renderHook(() => useUserKey('openAI'));

    expect(result.current.getExpiry()).toBe(expiredAt);
    expect(result.current.hasKey).toBe(true);
    expect(result.current.isKeyValid).toBe(false);
    expect(result.current.keyStatus).toBe('expired');
    expect(result.current.checkExpiry()).toBe(false);
  });

  it('keeps an unparseable key expiry present but invalid', () => {
    (useUserKeyQuery as jest.Mock).mockReturnValue({ data: { expiresAt: 'not-a-date' } });

    const { result } = renderHook(() => useUserKey('openAI'));

    expect(result.current.getExpiry()).toBe('not-a-date');
    expect(result.current.hasKey).toBe(true);
    expect(result.current.isKeyValid).toBe(false);
    expect(result.current.keyStatus).toBe('invalid');
    expect(result.current.checkExpiry()).toBe(false);
  });

  it('sends an empty expiry string when saving a never-expiring key', () => {
    (useUserKeyQuery as jest.Mock).mockReturnValue({ data: { expiresAt: null } });

    const { result } = renderHook(() => useUserKey('openAI'));

    result.current.saveUserKey('sk-never', null);

    expect(mutate).toHaveBeenCalledWith({
      name: 'openAI',
      value: 'sk-never',
      expiresAt: '',
    });
  });

  it('sends an ISO expiry when saving a dated key', () => {
    const expiresAt = Date.UTC(2026, 3, 21, 20, 0, 0);
    (useUserKeyQuery as jest.Mock).mockReturnValue({ data: { expiresAt: null } });

    const { result } = renderHook(() => useUserKey('openAI'));

    result.current.saveUserKey('sk-dated', expiresAt);

    expect(mutate).toHaveBeenCalledWith({
      name: 'openAI',
      value: 'sk-dated',
      expiresAt: '2026-04-21T20:00:00.000Z',
    });
  });
});
