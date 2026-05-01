import { useMemo, useCallback } from 'react';
import { EModelEndpoint } from 'librechat-data-provider';
import { useUserKeyQuery, useUpdateUserKeysMutation } from 'librechat-data-provider/react-query';
import { useGetEndpointsQuery } from '~/data-provider';

type UserKeyExpiry = string | null | undefined;
type SaveUserKeyOptions = {
  onSuccess?: () => void;
  onError?: (error: unknown) => void;
};

export type UserKeyStatus = 'missing' | 'valid' | 'expired' | 'invalid';

export const normalizeUserKeyExpiry = (expiresAt: UserKeyExpiry): string | undefined => {
  if (expiresAt == null || expiresAt === '') {
    return undefined;
  }

  return expiresAt;
};

export const getUserKeyStatus = (expiresAt: UserKeyExpiry): UserKeyStatus => {
  const normalizedExpiry = normalizeUserKeyExpiry(expiresAt);

  if (!normalizedExpiry) {
    return 'missing';
  }

  if (normalizedExpiry === 'never') {
    return 'valid';
  }

  const expiryTime = new Date(normalizedExpiry).getTime();
  if (Number.isNaN(expiryTime)) {
    return 'invalid';
  }

  return expiryTime < Date.now() ? 'expired' : 'valid';
};

export const isUserKeyValid = (expiresAt: UserKeyExpiry): boolean =>
  getUserKeyStatus(expiresAt) === 'valid';

const useUserKey = (endpoint: string) => {
  const { data: endpointsConfig } = useGetEndpointsQuery();
  const config = endpointsConfig?.[endpoint ?? ''];

  const { azure } = config ?? {};
  let keyName = endpoint;

  if (azure) {
    keyName = EModelEndpoint.azureOpenAI;
  }

  const updateKey = useUpdateUserKeysMutation();
  const checkUserKey = useUserKeyQuery(keyName);
  const expiresAt = checkUserKey.data?.expiresAt;
  const keyStatus = getUserKeyStatus(expiresAt);
  const hasKey = keyStatus !== 'missing';
  const isKeyValid = isUserKeyValid(expiresAt);

  const getExpiry = useCallback(() => {
    return normalizeUserKeyExpiry(expiresAt);
  }, [expiresAt]);

  const checkExpiry = useCallback(() => {
    return isUserKeyValid(expiresAt);
  }, [expiresAt]);

  const saveUserKey = useCallback(
    (userKey: string, expiresAt: number | null, options?: SaveUserKeyOptions) => {
      const dateStr = expiresAt ? new Date(expiresAt).toISOString() : '';
      const payload = {
        name: keyName,
        value: userKey,
        expiresAt: dateStr,
      };

      if (options == null) {
        updateKey.mutate(payload);
        return;
      }

      updateKey.mutate(payload, {
        onSuccess: () => options.onSuccess?.(),
        onError: (error) => options.onError?.(error),
      });
    },
    [updateKey, keyName],
  );

  return useMemo(
    () => ({ getExpiry, checkExpiry, saveUserKey, hasKey, isKeyValid, keyStatus }),
    [getExpiry, checkExpiry, saveUserKey, hasKey, isKeyValid, keyStatus],
  );
};

export default useUserKey;
