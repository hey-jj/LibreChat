import { renderHook, act } from '@testing-library/react';
import { Constants, LocalStorageKeys, StepEvents } from 'librechat-data-provider';
import type { TMessage, TSubmission } from 'librechat-data-provider';

type SSEEventListener = (e: Partial<MessageEvent> & { responseCode?: number }) => void;

interface MockSSEInstance {
  addEventListener: jest.Mock;
  stream: jest.Mock;
  close: jest.Mock;
  headers: Record<string, string>;
  _listeners: Record<string, SSEEventListener>;
  _emit: (event: string, data?: Partial<MessageEvent> & { responseCode?: number }) => void;
}

const mockSSEInstances: MockSSEInstance[] = [];

jest.mock('sse.js', () => ({
  SSE: jest.fn().mockImplementation(() => {
    const listeners: Record<string, SSEEventListener> = {};
    const instance: MockSSEInstance = {
      addEventListener: jest.fn((event: string, cb: SSEEventListener) => {
        listeners[event] = cb;
      }),
      stream: jest.fn(),
      close: jest.fn(),
      headers: {},
      _listeners: listeners,
      _emit: (event, data = {}) => listeners[event]?.(data as MessageEvent),
    };
    mockSSEInstances.push(instance);
    return instance;
  }),
}));

const mockSetQueryData = jest.fn();
const mockInvalidateQueries = jest.fn();
const mockRemoveQueries = jest.fn();
const mockQueryClient = {
  setQueryData: mockSetQueryData,
  invalidateQueries: mockInvalidateQueries,
  removeQueries: mockRemoveQueries,
};

jest.mock('@tanstack/react-query', () => ({
  ...jest.requireActual('@tanstack/react-query'),
  useQueryClient: () => mockQueryClient,
}));

jest.mock('recoil', () => ({
  ...jest.requireActual('recoil'),
  useSetRecoilState: () => jest.fn(),
}));

jest.mock('~/store', () => ({
  __esModule: true,
  default: {
    activeRunFamily: jest.fn(),
    abortScrollFamily: jest.fn(),
    showStopButtonByIndex: jest.fn(),
  },
}));

jest.mock('~/hooks/AuthContext', () => ({
  useAuthContext: () => ({ token: 'test-token', isAuthenticated: true }),
}));

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({ data: { balance: { enabled: false } } }),
  useGetUserBalance: () => ({ refetch: jest.fn() }),
  queueTitleGeneration: jest.fn(),
  streamStatusQueryKey: (conversationId: string) => ['streamStatus', conversationId],
}));

const mockErrorHandler = jest.fn();
const mockFinalHandler = jest.fn();
const mockCreatedHandler = jest.fn();
const mockAttachmentHandler = jest.fn();
const mockStepHandler = jest.fn();
const mockContentHandler = jest.fn();
const mockResetContentHandler = jest.fn();
const mockSyncStepMessage = jest.fn();
const mockAnnounceReplyStart = jest.fn();
const mockMessageHandler = jest.fn();
const mockSetIsSubmitting = jest.fn();
const mockClearStepMaps = jest.fn();

jest.mock('~/hooks/SSE/useEventHandlers', () =>
  jest.fn(() => ({
    errorHandler: mockErrorHandler,
    finalHandler: mockFinalHandler,
    createdHandler: mockCreatedHandler,
    attachmentHandler: mockAttachmentHandler,
    stepHandler: mockStepHandler,
    contentHandler: mockContentHandler,
    resetContentHandler: mockResetContentHandler,
    announceReplyStart: mockAnnounceReplyStart,
    syncStepMessage: mockSyncStepMessage,
    clearStepMaps: mockClearStepMaps,
    messageHandler: mockMessageHandler,
    setIsSubmitting: mockSetIsSubmitting,
    setShowStopButton: jest.fn(),
  })),
);

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('../../../../../packages/data-provider/dist/index.js');
  return {
    ...actual,
    createPayload: jest.fn(() => ({
      payload: { model: 'gpt-4o' },
      server: '/api/agents/chat',
    })),
    removeNullishValues: jest.fn((v: unknown) => v),
    apiBaseUrl: jest.fn(() => ''),
    request: {
      post: jest.fn().mockResolvedValue({ streamId: 'stream-123' }),
      refreshToken: jest.fn(),
      dispatchTokenUpdatedEvent: jest.fn(),
    },
  };
});

import useResumableSSE from '~/hooks/SSE/useResumableSSE';

const CONV_ID = 'conv-abc-123';

type PartialSubmission = {
  conversation: { conversationId?: string };
  userMessage: Record<string, unknown>;
  messages: Record<string, unknown>[];
  isTemporary: boolean;
  initialResponse: Record<string, unknown>;
  endpointOption: { endpoint: string };
  resumeStreamId?: string;
};

const buildSubmission = (overrides: Partial<PartialSubmission> = {}): TSubmission => {
  const conversationId = overrides.conversation?.conversationId ?? CONV_ID;
  return {
    conversation: { conversationId },
    userMessage: {
      messageId: 'msg-1',
      conversationId,
      text: 'Hello',
      isCreatedByUser: true,
      sender: 'User',
      parentMessageId: '00000000-0000-0000-0000-000000000000',
    },
    messages: [],
    isTemporary: false,
    initialResponse: {
      messageId: 'resp-1',
      conversationId,
      text: '',
      isCreatedByUser: false,
      sender: 'Assistant',
    },
    endpointOption: { endpoint: 'agents' },
    ...overrides,
  } as unknown as TSubmission;
};

const buildChatHelpers = (overrides: Partial<ReturnType<typeof createChatHelpers>> = {}) => ({
  ...createChatHelpers(),
  ...overrides,
});

const createChatHelpers = () => ({
  setMessages: jest.fn(),
  getMessages: jest.fn(() => []),
  setConversation: jest.fn(),
  setIsSubmitting: mockSetIsSubmitting,
  newConversation: jest.fn(),
  resetLatestMessage: jest.fn(),
});

const getLastSSE = (): MockSSEInstance => {
  const sse = mockSSEInstances[mockSSEInstances.length - 1];
  expect(sse).toBeDefined();
  return sse;
};

describe('useResumableSSE - 404 error path', () => {
  beforeEach(() => {
    mockSSEInstances.length = 0;
    localStorage.clear();
    mockErrorHandler.mockClear();
    mockFinalHandler.mockClear();
    mockCreatedHandler.mockClear();
    mockAttachmentHandler.mockClear();
    mockStepHandler.mockClear();
    mockContentHandler.mockClear();
    mockResetContentHandler.mockClear();
    mockSyncStepMessage.mockClear();
    mockAnnounceReplyStart.mockClear();
    mockMessageHandler.mockClear();
    mockClearStepMaps.mockClear();
    mockSetIsSubmitting.mockClear();
    mockInvalidateQueries.mockClear();
    mockRemoveQueries.mockClear();
  });

  const seedDraft = (conversationId: string) => {
    localStorage.setItem(`${LocalStorageKeys.TEXT_DRAFT}${conversationId}`, 'draft text');
    localStorage.setItem(`${LocalStorageKeys.FILES_DRAFT}${conversationId}`, '[]');
  };

  const render404Scenario = async (conversationId = CONV_ID) => {
    const submission = buildSubmission({ conversation: { conversationId } });
    const chatHelpers = buildChatHelpers();

    const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));

    await act(async () => {
      await Promise.resolve();
    });

    const sse = getLastSSE();

    await act(async () => {
      sse._emit('error', { responseCode: 404 });
    });

    return { sse, unmount, chatHelpers };
  };

  it('clears the text and files draft from localStorage on 404', async () => {
    seedDraft(CONV_ID);
    expect(localStorage.getItem(`${LocalStorageKeys.TEXT_DRAFT}${CONV_ID}`)).not.toBeNull();
    expect(localStorage.getItem(`${LocalStorageKeys.FILES_DRAFT}${CONV_ID}`)).not.toBeNull();

    const { unmount } = await render404Scenario(CONV_ID);

    expect(localStorage.getItem(`${LocalStorageKeys.TEXT_DRAFT}${CONV_ID}`)).toBeNull();
    expect(localStorage.getItem(`${LocalStorageKeys.FILES_DRAFT}${CONV_ID}`)).toBeNull();
    unmount();
  });

  it('invalidates message cache and clears stream status on 404 instead of showing error', async () => {
    const { unmount } = await render404Scenario(CONV_ID);

    expect(mockErrorHandler).not.toHaveBeenCalled();
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ['messages', CONV_ID],
    });
    expect(mockRemoveQueries).toHaveBeenCalledWith({
      queryKey: ['streamStatus', CONV_ID],
    });
    expect(mockClearStepMaps).toHaveBeenCalled();
    expect(mockSetIsSubmitting).toHaveBeenCalledWith(false);
    unmount();
  });

  it('clears both TEXT and FILES drafts for new-convo when conversationId is absent', async () => {
    localStorage.setItem(`${LocalStorageKeys.TEXT_DRAFT}${Constants.NEW_CONVO}`, 'unsent message');
    localStorage.setItem(`${LocalStorageKeys.FILES_DRAFT}${Constants.NEW_CONVO}`, '[]');

    const submission = buildSubmission({ conversation: {} });
    const chatHelpers = buildChatHelpers();

    const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));

    await act(async () => {
      await Promise.resolve();
    });

    const sse = getLastSSE();
    await act(async () => {
      sse._emit('error', { responseCode: 404 });
    });

    expect(localStorage.getItem(`${LocalStorageKeys.TEXT_DRAFT}${Constants.NEW_CONVO}`)).toBeNull();
    expect(
      localStorage.getItem(`${LocalStorageKeys.FILES_DRAFT}${Constants.NEW_CONVO}`),
    ).toBeNull();
    unmount();
  });

  it('closes the SSE connection on 404', async () => {
    const { sse, unmount } = await render404Scenario();

    expect(sse.close).toHaveBeenCalled();
    unmount();
  });

  it.each([undefined, 500, 503])(
    'does not call errorHandler for responseCode %s (reconnect path)',
    async (responseCode) => {
      const submission = buildSubmission();
      const chatHelpers = buildChatHelpers();

      const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));

      await act(async () => {
        await Promise.resolve();
      });

      const sse = getLastSSE();

      await act(async () => {
        sse._emit('error', { responseCode });
      });

      expect(mockErrorHandler).not.toHaveBeenCalled();
      unmount();
    },
  );

  it('treats unexpected SSE error payloads as transport failures instead of surfacing them', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const submission = buildSubmission();
    const chatHelpers = buildChatHelpers();

    const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));

    await act(async () => {
      await Promise.resolve();
    });

    const sse = getLastSSE();

    await act(async () => {
      sse._emit('error', {
        data: JSON.stringify({
          error: {
            message: 'Blocked by policy',
          },
        }),
      });
    });

    expect(mockErrorHandler).not.toHaveBeenCalled();
    expect(sse.close).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      '[ResumableSSE] Unexpected SSE error event payload received; treating as transport failure',
      { currentStreamId: 'stream-123' },
    );

    warnSpy.mockRestore();
    unmount();
  });

  it('surfaces in-band final resume failures through errorHandler', async () => {
    const submission = buildSubmission({
      resumeStreamId: 'stream-123',
    });
    const chatHelpers = buildChatHelpers();

    const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));

    await act(async () => {
      await Promise.resolve();
    });

    const sse = getLastSSE();

    await act(async () => {
      sse._emit('message', {
        data: JSON.stringify({
          final: true,
          error: {
            message: 'Unable to resume stream: canonical sync state unavailable.',
          },
        }),
      });
    });

    expect(mockFinalHandler).not.toHaveBeenCalled();
    expect(mockErrorHandler).toHaveBeenCalledWith({
      data: {
        text: 'Unable to resume stream: canonical sync state unavailable.',
      },
      submission: expect.anything(),
    });

    unmount();
  });
});

describe('useResumableSSE - sync payload replay', () => {
  beforeEach(() => {
    mockSSEInstances.length = 0;
    mockCreatedHandler.mockClear();
    mockAttachmentHandler.mockClear();
    mockStepHandler.mockClear();
    mockContentHandler.mockClear();
    mockResetContentHandler.mockClear();
    mockSyncStepMessage.mockClear();
    mockAnnounceReplyStart.mockClear();
    mockSetIsSubmitting.mockClear();
  });

  it('replays pending created, attachment, step, and content events through the correct handlers', async () => {
    const submission = buildSubmission({
      resumeStreamId: 'stream-123',
    });
    const chatHelpers = buildChatHelpers();

    const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));

    await act(async () => {
      await Promise.resolve();
    });

    const sse = getLastSSE();
    const syncPayload = {
      sync: true,
      resumeState: {
        runSteps: [],
        aggregatedContent: [],
        userMessage: {
          messageId: 'msg-1',
          conversationId: CONV_ID,
          text: 'Hello',
        },
        responseMessageId: 'resp-1',
        conversationId: CONV_ID,
        sender: 'Assistant',
      },
      pendingEvents: [
        {
          created: true,
          message: {
            messageId: 'msg-1',
            conversationId: CONV_ID,
            text: 'Hello',
            isCreatedByUser: true,
          },
        },
        {
          event: 'attachment',
          data: {
            type: 'file',
            messageId: 'resp-1',
          },
        },
        {
          event: 'on_run_step',
          data: {
            id: 'step-1',
            type: 'tool_calls',
          },
        },
        {
          type: 'text',
          text: 'delta',
          index: 0,
          messageId: 'resp-1',
          conversationId: CONV_ID,
          userMessageId: 'msg-1',
          thread_id: CONV_ID,
        },
      ],
    };

    await act(async () => {
      sse._emit('message', { data: JSON.stringify(syncPayload) });
    });

    expect(mockCreatedHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        conversation: { conversationId: CONV_ID },
        requestMessage: expect.objectContaining({
          messageId: 'msg-1',
          conversationId: CONV_ID,
          text: 'Hello',
          isCreatedByUser: true,
          sender: 'User',
          parentMessageId: '00000000-0000-0000-0000-000000000000',
        }),
        responseMessage: expect.objectContaining({
          messageId: 'resp-1',
          conversationId: CONV_ID,
          text: '',
          isCreatedByUser: false,
          sender: 'Assistant',
          parentMessageId: 'msg-1',
        }),
      }),
      expect.anything(),
    );
    expect(mockAttachmentHandler).toHaveBeenCalledWith({
      data: syncPayload.pendingEvents[1].data,
      submission: expect.anything(),
    });
    expect(mockAnnounceReplyStart).not.toHaveBeenCalled();
    expect(mockStepHandler).toHaveBeenCalledWith(syncPayload.pendingEvents[2], expect.anything());
    expect(mockContentHandler).toHaveBeenCalledWith({
      data: syncPayload.pendingEvents[3],
      submission: expect.anything(),
    });
    expect(mockStepHandler.mock.calls.some(([event]) => event?.event === 'attachment')).toBe(false);

    unmount();
  });

  it('hydrates aggregated content from sync resume state before replay continues', async () => {
    const submission = buildSubmission({
      resumeStreamId: 'stream-123',
    });
    const existingMessages: TMessage[] = [
      submission.userMessage,
      {
        messageId: 'resp-1',
        parentMessageId: 'msg-1',
        conversationId: CONV_ID,
        text: '',
        content: [{ type: 'text', text: 'stale' }],
        isCreatedByUser: false,
      },
    ];
    const chatHelpers = buildChatHelpers({
      getMessages: jest.fn(() => existingMessages),
    });

    const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));

    await act(async () => {
      await Promise.resolve();
    });

    const sse = getLastSSE();
    const runStep = {
      id: 'step-restore-1',
      type: 'tool_calls',
      index: 0,
      stepDetails: { type: 'tool_calls', tool_calls: [] },
      usage: null,
    };
    const restoredContent = [{ type: 'text', text: 'restored text' }];

    await act(async () => {
      sse._emit('message', {
        data: JSON.stringify({
          sync: true,
          resumeState: {
            runSteps: [runStep],
            aggregatedContent: restoredContent,
            userMessage: {
              messageId: 'msg-1',
              conversationId: CONV_ID,
              text: 'Hello',
            },
            responseMessageId: 'resp-1',
            conversationId: CONV_ID,
            sender: 'Assistant',
          },
          pendingEvents: [],
        }),
      });
    });

    expect(chatHelpers.setMessages).toHaveBeenCalledWith([
      existingMessages[0],
      {
        ...existingMessages[1],
        content: restoredContent,
      },
    ]);
    expect(mockResetContentHandler).toHaveBeenCalled();
    expect(mockSyncStepMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 'resp-1',
        content: restoredContent,
      }),
    );
    expect(mockStepHandler).toHaveBeenCalledWith(
      { event: StepEvents.ON_RUN_STEP, data: runStep },
      expect.anything(),
    );

    unmount();
  });

  it('rejects sync payloads missing explicit resume ids', async () => {
    const submission = buildSubmission({
      resumeStreamId: 'stream-123',
    });
    const chatHelpers = buildChatHelpers();

    const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));

    await act(async () => {
      await Promise.resolve();
    });

    mockCreatedHandler.mockClear();
    mockStepHandler.mockClear();
    mockContentHandler.mockClear();
    mockSyncStepMessage.mockClear();
    chatHelpers.setMessages.mockClear();

    const sse = getLastSSE();

    await act(async () => {
      sse._emit('message', {
        data: JSON.stringify({
          sync: true,
          resumeState: {
            runSteps: [],
            aggregatedContent: [{ type: 'text', text: 'restored text' }],
            userMessage: {
              conversationId: CONV_ID,
              text: 'Hello',
            },
          },
          pendingEvents: [],
        }),
      });
    });

    expect(mockCreatedHandler).not.toHaveBeenCalled();
    expect(mockStepHandler).not.toHaveBeenCalled();
    expect(mockContentHandler).not.toHaveBeenCalled();
    expect(mockSyncStepMessage).not.toHaveBeenCalled();
    expect(chatHelpers.setMessages).not.toHaveBeenCalled();

    unmount();
  });

  it('hydrates aggregated content only when the exact responseMessageId exists', async () => {
    const submission = buildSubmission({
      resumeStreamId: 'stream-123',
    });
    const existingMessages: TMessage[] = [
      submission.userMessage,
      {
        messageId: 'msg-1_',
        parentMessageId: 'msg-1',
        conversationId: CONV_ID,
        text: '',
        content: [{ type: 'text', text: 'stale' }],
        isCreatedByUser: false,
      },
    ];
    const chatHelpers = buildChatHelpers({
      getMessages: jest.fn(() => existingMessages),
    });

    const { unmount } = renderHook(() => useResumableSSE(submission, chatHelpers));

    await act(async () => {
      await Promise.resolve();
    });

    const restoredContent = [{ type: 'text', text: 'restored text' }];
    const sse = getLastSSE();

    await act(async () => {
      sse._emit('message', {
        data: JSON.stringify({
          sync: true,
          resumeState: {
            runSteps: [],
            aggregatedContent: restoredContent,
            userMessage: {
              messageId: 'msg-1',
              conversationId: CONV_ID,
              text: 'Hello',
            },
            responseMessageId: 'resp-1',
            conversationId: CONV_ID,
            sender: 'Assistant',
          },
          pendingEvents: [],
        }),
      });
    });

    expect(chatHelpers.setMessages).toHaveBeenCalledWith([
      existingMessages[0],
      existingMessages[1],
      {
        messageId: 'resp-1',
        parentMessageId: 'msg-1',
        conversationId: CONV_ID,
        text: '',
        content: restoredContent,
        isCreatedByUser: false,
      },
    ]);
    expect(mockResetContentHandler).toHaveBeenCalled();
    expect(mockSyncStepMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 'resp-1',
        content: restoredContent,
      }),
    );

    unmount();
  });
});
