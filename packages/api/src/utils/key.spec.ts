import { ErrorTypes } from 'librechat-data-provider';
import { checkUserKeyExpiry } from './key';

describe('checkUserKeyExpiry', () => {
  const ONE_MINUTE_MS = 60_000;

  it('accepts future key expiries', () => {
    const expiresAt = new Date(Date.now() + ONE_MINUTE_MS).toISOString();

    expect(() => checkUserKeyExpiry(expiresAt, 'openAI')).not.toThrow();
  });

  it('throws an explicit expired-key error for expired keys', () => {
    const expiresAt = new Date(Date.now() - ONE_MINUTE_MS).toISOString();

    expect(() => checkUserKeyExpiry(expiresAt, 'openAI')).toThrow(
      expect.objectContaining({
        message: expect.stringContaining(ErrorTypes.EXPIRED_USER_KEY),
      }),
    );
  });

  it('throws an explicit invalid-key error for unparseable expiries', () => {
    expect(() => checkUserKeyExpiry('not-a-date', 'openAI')).toThrow(
      JSON.stringify({
        type: ErrorTypes.INVALID_USER_KEY,
        reason: 'invalid_expiry',
        expiresAt: 'not-a-date',
        endpoint: 'openAI',
      }),
    );
  });
});
