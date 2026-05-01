const mockNavigate = jest.fn();
const mockGetQueryData = jest.fn();
const mockSetShowStopButton = jest.fn();
const mockSetIsSubmitting = jest.fn();
const mockResetLatestMultiMessage = jest.fn();
const mockSetFilesToDelete = jest.fn();

jest.mock('react-router-dom', () => ({
  useNavigate: jest.fn(),
}));

jest.mock('@tanstack/react-query', () => ({
  useQueryClient: jest.fn(),
}));

jest.mock('recoil', () => ({
  useSetRecoilState: jest.fn(),
  useResetRecoilState: jest.fn(),
  useRecoilValue: jest.fn(),
}));

jest.mock('~/hooks/Files/useSetFilesToDelete', () => ({
  __esModule: true,
  default: jest.fn(() => mockSetFilesToDelete),
}));

jest.mock('~/hooks/Conversations/useGetSender', () => ({
  __esModule: true,
  default: jest.fn(() => jest.fn(() => 'Assistant')),
}));

jest.mock('~/utils', () => {
  const actual = jest.requireActual('~/utils');
  return {
    ...actual,
    logger: {
      log: jest.fn(),
      dir: jest.fn(),
      error: jest.fn(),
    },
    createDualMessageContent: jest.fn(() => []),
  };
});

jest.mock('~/store', () => ({
  __esModule: true,
  default: {
    isTemporary: 'isTemporaryAtom',
    isSubmittingFamily: jest.fn(() => 'isSubmittingAtom'),
    showStopButtonByIndex: jest.fn(() => 'showStopButtonAtom'),
    latestMessageFamily: jest.fn(() => 'latestMessageAtom'),
  },
  useGetEphemeralAgent: jest.fn(() => jest.fn(() => null)),
}));

jest.mock('~/data-provider', () => ({
  startupConfigKey: jest.fn(() => 'startupConfig'),
}));

jest.mock('~/hooks/Input/useUserKey', () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock('~/hooks', () => ({
  useAuthContext: jest.fn(),
}));

import { act, renderHook } from '@testing-library/react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useRecoilValue, useResetRecoilState, useSetRecoilState } from 'recoil';
import { EModelEndpoint, QueryKeys } from 'librechat-data-provider';
import type { TConversation } from 'librechat-data-provider';
import useChatFunctions from '../useChatFunctions';
import useUserKey from '~/hooks/Input/useUserKey';
import { useAuthContext } from '~/hooks';

describe('useChatFunctions', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    (useNavigate as jest.Mock).mockReturnValue(mockNavigate);
    (useQueryClient as jest.Mock).mockReturnValue({
      getQueryData: mockGetQueryData,
    });
    (useSetRecoilState as jest.Mock).mockImplementation((atom) => {
      if (atom === 'isSubmittingAtom') {
        return mockSetIsSubmitting;
      }

      if (atom === 'showStopButtonAtom') {
        return mockSetShowStopButton;
      }

      return jest.fn();
    });
    (useResetRecoilState as jest.Mock).mockReturnValue(mockResetLatestMultiMessage);
    (useRecoilValue as jest.Mock).mockReturnValue(false);
    (useAuthContext as jest.Mock).mockReturnValue({
      user: { id: 'user-1' },
    });
    (useUserKey as jest.Mock).mockReturnValue({
      getExpiry: jest.fn(() => undefined),
      isKeyValid: false,
    });
    mockGetQueryData.mockImplementation((key) => {
      if (Array.isArray(key) && key[0] === QueryKeys.endpoints) {
        return {
          openAI: {
            userProvide: true,
          },
        };
      }

      return null;
    });
  });

  it('blocks submission when the endpoint requires a valid user key', () => {
    const setSubmission = jest.fn();
    const setMessages = jest.fn();
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    const conversation: TConversation = {
      conversationId: 'convo-1',
      endpoint: EModelEndpoint.openAI,
      title: 'New Chat',
      model: 'gpt-4o-mini',
      createdAt: '2026-04-30T00:00:00.000Z',
      updatedAt: '2026-04-30T00:00:00.000Z',
    };

    const { result } = renderHook(() =>
      useChatFunctions({
        index: 0,
        files: new Map(),
        setFiles: jest.fn(),
        getMessages: () => [],
        setMessages,
        isSubmitting: false,
        latestMessage: null,
        setSubmission,
        setLatestMessage: jest.fn(),
        conversation,
      }),
    );

    act(() => {
      result.current.ask({ text: 'hello world' });
    });

    expect(mockSetShowStopButton).toHaveBeenCalledWith(false);
    expect(mockResetLatestMultiMessage).toHaveBeenCalled();
    expect(setMessages).not.toHaveBeenCalled();
    expect(setSubmission).not.toHaveBeenCalled();
    expect(mockSetIsSubmitting).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(
      'cannot send message without a valid user key for openAI',
    );

    consoleError.mockRestore();
  });
});
