import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, act } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Constants, ContentTypes, StepEvents, StepTypes, request } from 'librechat-data-provider';
import type { Agents, TConversation, TMessage, TSubmission } from 'librechat-data-provider';
import { LiveAnnouncer } from '~/a11y';
import useResumableSSE, { type ChatHelpers } from '~/hooks/SSE/useResumableSSE';

type SSEEventListener = (e: Partial<MessageEvent> & { responseCode?: number }) => void;

interface MockSSEInstance {
  addEventListener: jest.Mock;
  stream: jest.Mock;
  close: jest.Mock;
  headers: Record<string, string>;
  url: string;
  _listeners: Record<string, SSEEventListener>;
  _emit: (event: string, data?: Partial<MessageEvent> & { responseCode?: number }) => void;
}

const mockSSEInstances: MockSSEInstance[] = [];

jest.mock('sse.js', () => ({
  SSE: jest.fn().mockImplementation((url: string) => {
    const listeners: Record<string, SSEEventListener> = {};
    const instance: MockSSEInstance = {
      addEventListener: jest.fn((event: string, cb: SSEEventListener) => {
        listeners[event] = cb;
      }),
      stream: jest.fn(),
      close: jest.fn(),
      headers: {},
      url,
      _listeners: listeners,
      _emit: (event, data = {}) => listeners[event]?.(data as MessageEvent),
    };
    mockSSEInstances.push(instance);
    return instance;
  }),
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
    abortScroll: jest.fn(),
    messageAttachmentsMap: jest.fn(),
  },
}));

jest.mock('~/hooks/AuthContext', () => ({
  useAuthContext: () => ({ token: 'test-token', isAuthenticated: true }),
}));

jest.mock('~/hooks/Agents', () => ({
  useApplyAgentTemplate: () => jest.fn(),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => {
    if (key === 'com_a11y_start') {
      return 'The AI has started their reply.';
    }
    if (key === 'com_a11y_ai_composing') {
      return 'The AI is still composing.';
    }
    if (key === 'com_a11y_end') {
      return 'The AI has finished their reply.';
    }
    if (key === 'com_a11y_summarize_started') {
      return 'Summarizing context.';
    }
    if (key === 'com_a11y_summarize_completed') {
      return 'Context summarized.';
    }
    if (key === 'com_a11y_summarize_failed') {
      return 'Summarization failed, continuing with available context.';
    }
    return key;
  },
}));

jest.mock('~/Providers', () => ({
  useLiveAnnouncer: jest.requireActual('~/Providers/AnnouncerContext').useLiveAnnouncer,
}));

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({ data: { balance: { enabled: false } } }),
  useGetUserBalance: () => ({ refetch: jest.fn() }),
  queueTitleGeneration: jest.fn(),
  streamStatusQueryKey: (conversationId: string) => ['streamStatus', conversationId],
  startupConfigKey: (isAuthenticated: boolean) => ['startupConfig', isAuthenticated],
}));

jest.mock('~/utils', () => ({
  logger: { log: jest.fn() },
  setDraft: jest.fn(),
  scrollToEnd: (callback?: () => void) => callback?.(),
  addConvoToAllQueries: jest.fn(),
  updateConvoInAllQueries: jest.fn(),
  removeConvoFromAllQueries: jest.fn(),
  findConversationInInfinite: jest.fn(() => null),
  clearAllDrafts: jest.fn(),
  addFileToCache: jest.fn(),
  getAllContentText: (
    message?: {
      text?: string;
      content?: Array<{ type?: string; text?: string | { value?: string } }>;
    } | null,
  ) => {
    if (!message) {
      return '';
    }
    if (message.text) {
      return message.text;
    }
    return (message.content ?? [])
      .filter((part) => part != null && part.type === 'text')
      .map((part) => {
        if (!('text' in part)) {
          return '';
        }
        return typeof part.text === 'string' ? part.text : (part.text?.value ?? '');
      })
      .filter((text) => text.length > 0)
      .join('\n');
  },
}));

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('../../../../../packages/data-provider/dist/index.js');
  return {
    ...actual,
    createPayload: jest.fn(() => ({
      payload: { model: 'gpt-4o' },
      server: '/api/agents/chat',
    })),
    removeNullishValues: jest.fn((value: unknown) => value),
    apiBaseUrl: jest.fn(() => ''),
    request: {
      post: jest.fn(),
      refreshToken: jest.fn(),
      dispatchTokenUpdatedEvent: jest.fn(),
    },
  };
});

const CONVERSATION_ID = 'conv-a11y-1';
const STREAM_ID = 'stream-a11y-1';
const START_TEXT = 'The AI has started their reply.';
const PROGRESS_TEXT = 'The AI is still composing.';
const END_TEXT = 'The AI has finished their reply.';
const NO_PARENT_ID = String(Constants.NO_PARENT);
const PRELIM_RESPONSE_MESSAGE_ID = String(Constants.USE_PRELIM_RESPONSE_MESSAGE_ID);

const createQueryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

const createWrapper =
  (queryClient: QueryClient, initialEntry = `/c/${CONVERSATION_ID}`) =>
  ({ children }: React.PropsWithChildren) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter
        initialEntries={[initialEntry]}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <Routes>
          <Route path="/c/:conversationId" element={<LiveAnnouncer>{children}</LiveAnnouncer>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );

const createUserMessage = (overrides: Partial<TMessage> = {}): TMessage => ({
  messageId: 'user-msg-1',
  conversationId: CONVERSATION_ID,
  parentMessageId: NO_PARENT_ID,
  isCreatedByUser: true,
  text: 'Hello',
  sender: 'User',
  ...overrides,
});

const createAssistantMessage = (overrides: Partial<TMessage> = {}): TMessage => ({
  messageId: 'assistant-msg-1',
  conversationId: CONVERSATION_ID,
  parentMessageId: 'user-msg-1',
  isCreatedByUser: false,
  text: '',
  sender: 'Assistant',
  content: [],
  ...overrides,
});

const createSubmission = (overrides: Partial<TSubmission> = {}): TSubmission =>
  ({
    conversation: {
      conversationId: CONVERSATION_ID,
      endpoint: 'agents',
      title: 'Test conversation',
    },
    userMessage: createUserMessage(),
    messages: [],
    isTemporary: false,
    initialResponse: createAssistantMessage({
      messageId: 'assistant-prelim-1',
    }),
    endpointOption: { endpoint: 'agents' },
    ...overrides,
  }) as TSubmission;

const createRunStep = (overrides: Partial<Agents.RunStep> = {}): Agents.RunStep => ({
  id: 'step-1',
  runId: PRELIM_RESPONSE_MESSAGE_ID,
  index: 0,
  type: StepTypes.MESSAGE_CREATION,
  stepDetails: {
    type: StepTypes.MESSAGE_CREATION,
    message_creation: { message_id: 'assistant-msg-1' },
  },
  usage: null,
  ...overrides,
});

const createMessageDelta = (stepId: string, text: string): Agents.MessageDeltaEvent => ({
  id: stepId,
  delta: {
    content: [{ type: ContentTypes.TEXT, text }],
  },
});

const flushMicrotasks = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

const getLastSSE = (): MockSSEInstance => {
  const sse = mockSSEInstances[mockSSEInstances.length - 1];
  expect(sse).toBeDefined();
  return sse;
};

const getLiveRegions = () => {
  const liveRegions = document.querySelectorAll<HTMLElement>(
    '[aria-live="polite"][aria-atomic="true"]',
  );
  expect(liveRegions).toHaveLength(2);
  return {
    statusRegion: liveRegions[0],
    logRegion: liveRegions[1],
  };
};

const trackStatusAnnouncements = (statusRegion: HTMLElement) => {
  const announcements: string[] = [];
  const observer = new MutationObserver(() => {
    const nextText = statusRegion.textContent?.trim() ?? '';
    if (nextText.length > 0) {
      announcements.push(nextText);
    }
  });

  observer.observe(statusRegion, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  return {
    announcements,
    disconnect: () => observer.disconnect(),
  };
};

const emitMessage = async (sse: MockSSEInstance, payload: unknown) => {
  await act(async () => {
    sse._emit('message', { data: JSON.stringify(payload) });
  });
};

const createChatHelpers = (
  submission: TSubmission,
): { chatHelpers: ChatHelpers; getMessages: () => TMessage[] } => {
  let messages = [...(submission.messages as TMessage[])];
  let conversation = (submission.conversation as TConversation | null) ?? null;
  let isSubmitting = false;

  const setMessages: ChatHelpers['setMessages'] = (nextMessages) => {
    messages = nextMessages;
  };

  const getMessagesForHook: ChatHelpers['getMessages'] = () => messages;
  const getMessages = (): TMessage[] => messages;

  const setConversation: NonNullable<ChatHelpers['setConversation']> = (nextConversation) => {
    conversation =
      typeof nextConversation === 'function'
        ? nextConversation(conversation ?? null)
        : nextConversation;
    return conversation;
  };

  const setIsSubmitting: ChatHelpers['setIsSubmitting'] = (nextIsSubmitting) => {
    isSubmitting =
      typeof nextIsSubmitting === 'function' ? nextIsSubmitting(isSubmitting) : nextIsSubmitting;
    return isSubmitting;
  };

  return {
    chatHelpers: {
      setMessages: jest.fn(setMessages),
      getMessages: jest.fn(getMessagesForHook),
      setConversation: jest.fn(setConversation),
      setIsSubmitting: jest.fn(setIsSubmitting),
      newConversation: jest.fn(),
      resetLatestMessage: jest.fn(),
    },
    getMessages,
  };
};

describe('useResumableSSE announcer integration', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-04-21T17:00:00.000Z'));
    mockSSEInstances.length = 0;
    (request.post as jest.Mock).mockResolvedValue({ streamId: STREAM_ID });
    (request.refreshToken as jest.Mock).mockReset();
    (request.dispatchTokenUpdatedEvent as jest.Mock).mockReset();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('updates the live announcer through the real resumable SSE path for start, progress, and end', async () => {
    const queryClient = createQueryClient();
    const submission = createSubmission({
      userMessage: createUserMessage({
        parentMessageId: 'parent-msg-1',
      }),
    });
    const { chatHelpers } = createChatHelpers(submission);

    renderHook(() => useResumableSSE(submission, chatHelpers), {
      wrapper: createWrapper(queryClient),
    });

    await flushMicrotasks();

    const sse = getLastSSE();
    const { statusRegion, logRegion } = getLiveRegions();

    await emitMessage(sse, {
      created: true,
      message: {
        messageId: 'user-msg-server-1',
        conversationId: CONVERSATION_ID,
      },
    });

    expect(statusRegion).toHaveTextContent(START_TEXT);

    act(() => {
      jest.advanceTimersByTime(7001);
    });

    await emitMessage(sse, {
      event: StepEvents.ON_RUN_STEP,
      data: createRunStep(),
    });

    expect(statusRegion).toHaveTextContent(PROGRESS_TEXT);

    await emitMessage(sse, {
      final: true,
      conversation: { conversationId: CONVERSATION_ID },
      requestMessage: createUserMessage({
        messageId: 'user-msg-server-1',
      }),
      responseMessage: createAssistantMessage({
        messageId: 'assistant-final-1',
        parentMessageId: 'user-msg-server-1',
        text: 'Final streamed reply',
      }),
    });

    expect(statusRegion).toHaveTextContent(END_TEXT);
    expect(logRegion).toHaveTextContent('Final streamed reply');
  });

  it('updates the live announcer for resumed start, progress, and end through the real sync path', async () => {
    const queryClient = createQueryClient();
    const userMessage = createUserMessage();
    const responseMessage = createAssistantMessage({
      messageId: 'assistant-resume-1',
      parentMessageId: userMessage.messageId,
    });
    const submission = createSubmission({
      userMessage,
      messages: [userMessage, responseMessage],
      initialResponse: responseMessage,
      resumeStreamId: STREAM_ID,
    } as Partial<TSubmission>);
    const { chatHelpers, getMessages } = createChatHelpers(submission);

    renderHook(() => useResumableSSE(submission, chatHelpers), {
      wrapper: createWrapper(queryClient),
    });

    await flushMicrotasks();

    const sse = getLastSSE();
    const { statusRegion, logRegion } = getLiveRegions();

    await emitMessage(sse, {
      sync: true,
      resumeState: {
        userMessage: {
          messageId: userMessage.messageId,
          conversationId: userMessage.conversationId,
          text: userMessage.text,
        },
        responseMessageId: responseMessage.messageId,
        aggregatedContent: [{ type: ContentTypes.TEXT, text: 'Recovered reply' }],
        runSteps: [
          createRunStep({
            id: 'resume-step-1',
            runId: responseMessage.messageId,
          }),
        ],
      },
      pendingEvents: [
        {
          event: StepEvents.ON_MESSAGE_DELTA,
          data: createMessageDelta('resume-step-1', ' plus replayed delta'),
        },
      ],
    });

    expect(statusRegion).toHaveTextContent(START_TEXT);

    let updatedResponse = (getMessages() ?? []).find(
      (message) => message.messageId === responseMessage.messageId,
    );
    expect(updatedResponse?.content?.[0]).toMatchObject({
      type: ContentTypes.TEXT,
      text: 'Recovered reply plus replayed delta',
    });

    act(() => {
      jest.advanceTimersByTime(7001);
    });

    await emitMessage(sse, {
      event: StepEvents.ON_MESSAGE_DELTA,
      data: createMessageDelta('resume-step-1', ' plus live delta'),
    });

    expect(statusRegion).toHaveTextContent(PROGRESS_TEXT);

    updatedResponse = (getMessages() ?? []).find(
      (message) => message.messageId === responseMessage.messageId,
    );
    expect(updatedResponse?.content?.[0]).toMatchObject({
      type: ContentTypes.TEXT,
      text: 'Recovered reply plus replayed delta plus live delta',
    });

    await emitMessage(sse, {
      final: true,
      conversation: { conversationId: CONVERSATION_ID },
      requestMessage: createUserMessage({
        messageId: userMessage.messageId,
      }),
      responseMessage: createAssistantMessage({
        messageId: responseMessage.messageId,
        parentMessageId: userMessage.messageId,
        text: 'Recovered final reply',
      }),
    });

    expect(statusRegion).toHaveTextContent(END_TEXT);
    expect(logRegion).toHaveTextContent('Recovered final reply');
  });

  it('relies on the replayed created event to drive resumed start, progress, and end announcements even after a delayed sync', async () => {
    const queryClient = createQueryClient();
    const userMessage = createUserMessage();
    const responseMessage = createAssistantMessage({
      messageId: 'assistant-resume-created-1',
      parentMessageId: userMessage.messageId,
    });
    const submission = createSubmission({
      userMessage,
      messages: [userMessage, responseMessage],
      initialResponse: responseMessage,
      resumeStreamId: STREAM_ID,
    } as Partial<TSubmission>);
    const { chatHelpers } = createChatHelpers(submission);

    renderHook(() => useResumableSSE(submission, chatHelpers), {
      wrapper: createWrapper(queryClient),
    });

    await flushMicrotasks();

    const sse = getLastSSE();
    const { statusRegion, logRegion } = getLiveRegions();
    const tracker = trackStatusAnnouncements(statusRegion);

    act(() => {
      jest.advanceTimersByTime(7001);
    });

    await emitMessage(sse, {
      sync: true,
      resumeState: {
        userMessage: {
          messageId: userMessage.messageId,
          conversationId: userMessage.conversationId,
          text: userMessage.text,
        },
        responseMessageId: responseMessage.messageId,
        aggregatedContent: [{ type: ContentTypes.TEXT, text: 'Recovered reply' }],
        runSteps: [
          createRunStep({
            id: 'resume-created-step-1',
            runId: responseMessage.messageId,
          }),
        ],
      },
      pendingEvents: [
        {
          created: true,
          message: {
            messageId: userMessage.messageId,
            conversationId: userMessage.conversationId,
            parentMessageId: userMessage.parentMessageId,
            text: userMessage.text,
            isCreatedByUser: true,
          },
        },
        {
          event: StepEvents.ON_MESSAGE_DELTA,
          data: createMessageDelta('resume-created-step-1', ' plus replayed delta'),
        },
      ],
    });

    expect(statusRegion).toHaveTextContent(START_TEXT);

    act(() => {
      jest.advanceTimersByTime(7001);
    });

    await emitMessage(sse, {
      event: StepEvents.ON_MESSAGE_DELTA,
      data: createMessageDelta('resume-created-step-1', ' plus live delta'),
    });

    expect(statusRegion).toHaveTextContent(PROGRESS_TEXT);

    await emitMessage(sse, {
      final: true,
      conversation: { conversationId: CONVERSATION_ID },
      requestMessage: createUserMessage({
        messageId: userMessage.messageId,
      }),
      responseMessage: createAssistantMessage({
        messageId: responseMessage.messageId,
        parentMessageId: userMessage.messageId,
        text: 'Recovered final reply',
      }),
    });

    expect(tracker.announcements).toEqual([START_TEXT, PROGRESS_TEXT, END_TEXT]);
    expect(statusRegion).toHaveTextContent(END_TEXT);
    expect(logRegion).toHaveTextContent('Recovered final reply');

    tracker.disconnect();
  });

  it('rewrites resumed PRELIM step traffic onto the canonical response message id', async () => {
    const queryClient = createQueryClient();
    const userMessage = createUserMessage();
    const responseMessage = createAssistantMessage({
      messageId: 'assistant-resume-prelim-1',
      parentMessageId: userMessage.messageId,
    });
    const submission = createSubmission({
      userMessage,
      messages: [userMessage, responseMessage],
      initialResponse: createAssistantMessage({
        messageId: 'assistant-stale-prelim',
        parentMessageId: userMessage.messageId,
      }),
      resumeStreamId: STREAM_ID,
    } as Partial<TSubmission>);
    const { chatHelpers, getMessages } = createChatHelpers(submission);

    renderHook(() => useResumableSSE(submission, chatHelpers), {
      wrapper: createWrapper(queryClient),
    });

    await flushMicrotasks();

    const sse = getLastSSE();

    await emitMessage(sse, {
      sync: true,
      resumeState: {
        userMessage: {
          messageId: userMessage.messageId,
          conversationId: userMessage.conversationId,
          text: userMessage.text,
        },
        responseMessageId: responseMessage.messageId,
        aggregatedContent: [{ type: ContentTypes.TEXT, text: 'Recovered reply' }],
        runSteps: [
          createRunStep({
            id: 'resume-prelim-step-1',
            runId: PRELIM_RESPONSE_MESSAGE_ID,
          }),
        ],
      },
      pendingEvents: [],
    });

    act(() => {
      jest.advanceTimersByTime(7001);
    });

    await emitMessage(sse, {
      event: StepEvents.ON_MESSAGE_DELTA,
      data: createMessageDelta('resume-prelim-step-1', ' plus live delta'),
    });

    const updatedResponse = (getMessages() ?? []).find(
      (message) => message.messageId === responseMessage.messageId,
    );
    expect(updatedResponse?.content?.[0]).toMatchObject({
      type: ContentTypes.TEXT,
      text: 'Recovered reply plus live delta',
    });
    expect(
      (getMessages() ?? []).some((message) => message.messageId === 'assistant-stale-prelim'),
    ).toBe(false);
  });
});
