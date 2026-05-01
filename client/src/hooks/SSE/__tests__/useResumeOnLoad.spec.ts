import { renderHook, act } from '@testing-library/react';
import type { Agents, TConversation, TMessage, TSubmission } from 'librechat-data-provider';
import { useStreamStatus } from '~/data-provider';
import useResumeOnLoad from '~/hooks/SSE/useResumeOnLoad';

const mockSubmissionAtomToken = Symbol('submissionByIndex');
const mockConversationAtomToken = Symbol('conversationByIndex');

let mockCurrentSubmission: TSubmission | null = null;
let mockCurrentConversation: TConversation | null = null;
const mockSetSubmission = jest.fn();

jest.mock('recoil', () => ({
  ...jest.requireActual('recoil'),
  useSetRecoilState: jest.fn((atom) => {
    if (atom === mockSubmissionAtomToken) {
      return mockSetSubmission;
    }
    return jest.fn();
  }),
  useRecoilValue: jest.fn((atom) => {
    if (atom === mockSubmissionAtomToken) {
      return mockCurrentSubmission;
    }
    if (atom === mockConversationAtomToken) {
      return mockCurrentConversation;
    }
    return null;
  }),
}));

jest.mock('~/store', () => ({
  __esModule: true,
  default: {
    submissionByIndex: jest.fn(() => mockSubmissionAtomToken),
    conversationByIndex: jest.fn(() => mockConversationAtomToken),
  },
}));

jest.mock('~/data-provider', () => ({
  useStreamStatus: jest.fn(),
}));

const mockUseStreamStatus = useStreamStatus as jest.MockedFunction<typeof useStreamStatus>;

const CONVERSATION_ID = 'conv-resume-1';
const STREAM_ID = 'stream-resume-1';

const createUserMessage = (overrides: Partial<TMessage> = {}): TMessage =>
  ({
    messageId: 'user-msg-1',
    conversationId: CONVERSATION_ID,
    parentMessageId: '00000000-0000-0000-0000-000000000000',
    text: 'Hello',
    isCreatedByUser: true,
    role: 'user',
    sender: 'User',
    ...overrides,
  }) as TMessage;

const createAssistantMessage = (overrides: Partial<TMessage> = {}): TMessage =>
  ({
    messageId: 'assistant-msg-1',
    conversationId: CONVERSATION_ID,
    parentMessageId: 'user-msg-1',
    text: '',
    content: [{ type: 'text', text: 'stale reply' }],
    isCreatedByUser: false,
    role: 'assistant',
    sender: 'Assistant',
    ...overrides,
  }) as TMessage;

const createCanonicalResumeState = (
  overrides: Partial<Agents.ResumeState> = {},
): Agents.ResumeState => ({
  runSteps: [],
  aggregatedContent: [{ type: 'text', text: 'Recovered reply' }],
  userMessage: {
    messageId: 'user-msg-1',
    conversationId: CONVERSATION_ID,
    text: 'Hello',
  },
  responseMessageId: 'assistant-msg-1',
  sender: 'Assistant',
  ...overrides,
});

const flushEffects = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};

describe('useResumeOnLoad', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    mockCurrentSubmission = null;
    mockCurrentConversation = {
      conversationId: CONVERSATION_ID,
      endpoint: 'agents',
      title: 'Resume conversation',
    } as TConversation;
    mockSetSubmission.mockReset();
    mockUseStreamStatus.mockReset();
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('creates a resumable submission only when stream status includes canonical resume ids', async () => {
    const userMessage = createUserMessage();
    const responseMessage = createAssistantMessage();
    const messages = [userMessage, responseMessage];

    mockUseStreamStatus.mockReturnValue({
      data: {
        active: true,
        streamId: STREAM_ID,
        status: 'running',
        resumeState: createCanonicalResumeState(),
      },
      isSuccess: true,
      isFetching: false,
    } as ReturnType<typeof useStreamStatus>);

    renderHook(() => useResumeOnLoad(CONVERSATION_ID, () => messages));

    await flushEffects();

    expect(mockSetSubmission).toHaveBeenCalledWith(
      expect.objectContaining({
        messages,
        userMessage: expect.objectContaining({
          messageId: userMessage.messageId,
        }),
        initialResponse: expect.objectContaining({
          messageId: responseMessage.messageId,
          content: [{ type: 'text', text: 'Recovered reply' }],
        }),
        conversation: expect.objectContaining({
          conversationId: CONVERSATION_ID,
        }),
        resumeStreamId: STREAM_ID,
      }),
    );
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('refuses active stream status that omits resumeState instead of creating a synthetic fallback submission', async () => {
    const messages = [createUserMessage(), createAssistantMessage()];

    mockUseStreamStatus.mockReturnValue({
      data: {
        active: true,
        streamId: STREAM_ID,
        status: 'running',
        aggregatedContent: [{ type: 'text', text: 'Recovered reply' }],
      },
      isSuccess: true,
      isFetching: false,
    } as ReturnType<typeof useStreamStatus>);

    renderHook(() => useResumeOnLoad(CONVERSATION_ID, () => messages));

    await flushEffects();

    expect(mockSetSubmission).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      '[ResumeOnLoad] Active stream missing canonical resume state',
      {
        conversationId: CONVERSATION_ID,
        streamId: STREAM_ID,
        resumeError: null,
      },
    );
  });

  it.each([
    [
      'missing user message id',
      createCanonicalResumeState({
        userMessage: {
          conversationId: CONVERSATION_ID,
          text: 'Hello',
        },
      }),
    ],
    [
      'missing response message id',
      createCanonicalResumeState({
        responseMessageId: undefined,
      }),
    ],
    [
      'non-array runSteps',
      createCanonicalResumeState({
        runSteps: {} as never,
      }),
    ],
    [
      'non-array aggregatedContent',
      createCanonicalResumeState({
        aggregatedContent: {} as never,
      }),
    ],
  ])('refuses non-canonical resumeState with %s', async (_label, resumeState) => {
    const messages = [createUserMessage(), createAssistantMessage()];

    mockUseStreamStatus.mockReturnValue({
      data: {
        active: true,
        streamId: STREAM_ID,
        status: 'running',
        resumeState,
      },
      isSuccess: true,
      isFetching: false,
    } as ReturnType<typeof useStreamStatus>);

    renderHook(() => useResumeOnLoad(CONVERSATION_ID, () => messages));

    await flushEffects();

    expect(mockSetSubmission).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      '[ResumeOnLoad] Resume state missing canonical message identifiers',
      {
        conversationId: CONVERSATION_ID,
        streamId: STREAM_ID,
        resumeError: null,
      },
    );
  });

  it('retries resume when a later status refresh becomes canonical', async () => {
    const messages = [createUserMessage(), createAssistantMessage()];
    let streamStatus = {
      data: {
        active: true,
        streamId: STREAM_ID,
        status: 'running',
        resumeState: createCanonicalResumeState({
          responseMessageId: undefined,
        }),
      },
      isSuccess: true,
      isFetching: false,
    } as ReturnType<typeof useStreamStatus>;

    mockUseStreamStatus.mockImplementation(() => streamStatus);

    const { rerender } = renderHook(() => useResumeOnLoad(CONVERSATION_ID, () => messages));

    await flushEffects();

    expect(mockSetSubmission).not.toHaveBeenCalled();

    streamStatus = {
      data: {
        active: true,
        streamId: STREAM_ID,
        status: 'running',
        resumeState: createCanonicalResumeState(),
      },
      isSuccess: true,
      isFetching: false,
    } as ReturnType<typeof useStreamStatus>;

    rerender();
    await flushEffects();

    expect(mockSetSubmission).toHaveBeenCalledWith(
      expect.objectContaining({
        resumeStreamId: STREAM_ID,
        userMessage: expect.objectContaining({
          messageId: 'user-msg-1',
        }),
        initialResponse: expect.objectContaining({
          messageId: 'assistant-msg-1',
        }),
      }),
    );
  });
});
