jest.mock('~/Providers/ChatContext', () => ({
  useChatContext: jest.fn(),
}));

jest.mock('~/data-provider', () => ({
  useGetEndpointsQuery: jest.fn(),
}));

jest.mock('./useUserKey', () => ({
  __esModule: true,
  default: jest.fn(),
}));

import { renderHook } from '@testing-library/react';
import { useChatContext } from '~/Providers/ChatContext';
import { useGetEndpointsQuery } from '~/data-provider';
import useUserKey from './useUserKey';
import useRequiresKey from './useRequiresKey';

describe('useRequiresKey', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (useChatContext as jest.Mock).mockReturnValue({
      conversation: { endpoint: 'openAI' },
    });
  });

  it('requires a key when the endpoint is BYOK and no key is available', () => {
    (useGetEndpointsQuery as jest.Mock).mockReturnValue({
      data: { openAI: { userProvide: true } },
    });
    (useUserKey as jest.Mock).mockReturnValue({
      hasKey: false,
      isKeyValid: false,
      keyStatus: 'missing',
    });

    const { result } = renderHook(() => useRequiresKey());

    expect(result.current).toEqual({
      requiresKey: true,
      userProvidesKey: true,
      hasKey: false,
      keyStatus: 'missing',
    });
  });

  it('unlocks when the endpoint is BYOK and a valid key is present', () => {
    (useGetEndpointsQuery as jest.Mock).mockReturnValue({
      data: { openAI: { userProvide: true } },
    });
    (useUserKey as jest.Mock).mockReturnValue({
      hasKey: true,
      isKeyValid: true,
      keyStatus: 'valid',
    });

    const { result } = renderHook(() => useRequiresKey());

    expect(result.current.requiresKey).toBe(false);
  });

  it('re-locks after a valid key is revoked', () => {
    (useGetEndpointsQuery as jest.Mock).mockReturnValue({
      data: { openAI: { userProvide: true } },
    });
    (useUserKey as jest.Mock)
      .mockReturnValueOnce({
        hasKey: true,
        isKeyValid: true,
        keyStatus: 'valid',
      })
      .mockReturnValueOnce({
        hasKey: false,
        isKeyValid: false,
        keyStatus: 'missing',
      });

    const { result, rerender } = renderHook(() => useRequiresKey());

    expect(result.current).toEqual({
      requiresKey: false,
      userProvidesKey: true,
      hasKey: true,
      keyStatus: 'valid',
    });

    rerender();

    expect(result.current).toEqual({
      requiresKey: true,
      userProvidesKey: true,
      hasKey: false,
      keyStatus: 'missing',
    });
  });

  it('stays unlocked when the endpoint does not require a user key', () => {
    (useGetEndpointsQuery as jest.Mock).mockReturnValue({
      data: { openAI: { userProvide: false } },
    });
    (useUserKey as jest.Mock).mockReturnValue({
      hasKey: false,
      isKeyValid: false,
      keyStatus: 'missing',
    });

    const { result } = renderHook(() => useRequiresKey());

    expect(result.current).toEqual({
      requiresKey: false,
      userProvidesKey: false,
      hasKey: false,
      keyStatus: 'missing',
    });
  });

  it('re-locks when the stored key is expired', () => {
    (useGetEndpointsQuery as jest.Mock).mockReturnValue({
      data: { openAI: { userProvide: true } },
    });
    (useUserKey as jest.Mock).mockReturnValue({
      hasKey: true,
      isKeyValid: false,
      keyStatus: 'expired',
    });

    const { result } = renderHook(() => useRequiresKey());

    expect(result.current).toEqual({
      requiresKey: true,
      userProvidesKey: true,
      hasKey: true,
      keyStatus: 'expired',
    });
  });

  it('re-locks when the stored key expiry cannot be parsed', () => {
    (useGetEndpointsQuery as jest.Mock).mockReturnValue({
      data: { openAI: { userProvide: true } },
    });
    (useUserKey as jest.Mock).mockReturnValue({
      hasKey: true,
      isKeyValid: false,
      keyStatus: 'invalid',
    });

    const { result } = renderHook(() => useRequiresKey());

    expect(result.current).toEqual({
      requiresKey: true,
      userProvidesKey: true,
      hasKey: true,
      keyStatus: 'invalid',
    });
  });

  it('stays locked until endpoint key requirements are resolved', () => {
    (useGetEndpointsQuery as jest.Mock).mockReturnValue({
      data: undefined,
    });
    (useUserKey as jest.Mock).mockReturnValue({
      hasKey: false,
      isKeyValid: false,
      keyStatus: 'missing',
    });

    const { result } = renderHook(() => useRequiresKey());

    expect(result.current).toEqual({
      requiresKey: true,
      userProvidesKey: false,
      hasKey: false,
      keyStatus: 'missing',
    });
  });
});
