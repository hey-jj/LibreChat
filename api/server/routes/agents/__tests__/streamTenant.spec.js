const express = require('express');
const request = require('supertest');

const mockGenerationJobManager = {
  getJob: jest.fn(),
  subscribe: jest.fn(),
  subscribeWithResume: jest.fn(),
  getResumeState: jest.fn(),
  markSyncSent: jest.fn(),
  abortJob: jest.fn(),
  getActiveJobIdsForUser: jest.fn().mockResolvedValue([]),
};
const mockSendEvent = jest.fn((...args) => {
  const { sendEvent } = jest.requireActual('@librechat/api');
  return sendEvent(...args);
});
const mockCreateSyncEvent = jest.fn(({ resumeState, pendingEvents = [] }) => {
  return {
    sync: true,
    resumeState,
    pendingEvents,
  };
});
const mockCreateFinalErrorEvent = jest.fn((message, code) => {
  return {
    final: true,
    error: {
      message,
      ...(code != null ? { code } : {}),
    },
  };
});
const mockIsCanonicalResumeState = jest.fn((resumeState) => {
  return (
    resumeState != null &&
    typeof resumeState === 'object' &&
    Array.isArray(resumeState.runSteps) &&
    (resumeState.aggregatedContent == null || Array.isArray(resumeState.aggregatedContent)) &&
    typeof resumeState.userMessage?.messageId === 'string' &&
    resumeState.userMessage.messageId.length > 0 &&
    typeof resumeState.responseMessageId === 'string' &&
    resumeState.responseMessageId.length > 0
  );
});
const mockIsReplayEvent = jest.fn((event) => {
  if (event == null || typeof event !== 'object') {
    return false;
  }

  if (event.created === true && typeof event.message?.messageId === 'string') {
    return true;
  }

  if (event.event === 'attachment' && typeof event.data?.messageId === 'string') {
    return true;
  }

  if (event.event === 'on_run_step' && event.data != null && typeof event.data === 'object') {
    return true;
  }

  return (
    typeof event.type === 'string' &&
    typeof event.messageId === 'string' &&
    typeof event.conversationId === 'string' &&
    typeof event.userMessageId === 'string' &&
    typeof event.thread_id === 'string' &&
    typeof event.index === 'number'
  );
});
const RESUME_SYNC_UNAVAILABLE_MESSAGE =
  'Unable to resume stream: canonical sync state unavailable.';
const RESUME_SYNC_UNAVAILABLE_CODE = 'canonical_resume_state_unavailable';

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: {
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
  },
}));

jest.mock('@librechat/api', () => {
  const actual = jest.requireActual('@librechat/api');
  return {
    ...actual,
    isEnabled: jest.fn().mockReturnValue(false),
    sendEvent: (...args) => mockSendEvent(...args),
    isCanonicalResumeState: (...args) => mockIsCanonicalResumeState(...args),
    isReplayEvent: (...args) => mockIsReplayEvent(...args),
    createSyncEvent: (...args) => mockCreateSyncEvent(...args),
    createFinalErrorEvent: (...args) => mockCreateFinalErrorEvent(...args),
    GenerationJobManager: mockGenerationJobManager,
  };
});

jest.mock('~/models', () => ({
  saveMessage: jest.fn(),
}));

let mockUserId = 'user-123';
let mockTenantId;
const mockUaParser = jest.fn((req, res, next) => next());

jest.mock('~/server/middleware', () => ({
  uaParser: (...args) => mockUaParser(...args),
  checkBan: (req, res, next) => next(),
  requireJwtAuth: (req, res, next) => {
    req.user = { id: mockUserId, tenantId: mockTenantId };
    next();
  },
  messageIpLimiter: (req, res, next) => next(),
  configMiddleware: (req, res, next) => next(),
  messageUserLimiter: (req, res, next) => next(),
}));

jest.mock('~/server/routes/agents/chat', () => require('express').Router());
jest.mock('~/server/routes/agents/v1', () => ({
  v1: require('express').Router(),
}));
jest.mock('~/server/routes/agents/openai', () => require('express').Router());
jest.mock('~/server/routes/agents/responses', () => require('express').Router());

const agentsRouter = require('../index');
const app = express();
app.use(express.json());
app.use('/agents', agentsRouter);

function mockSubscribeSuccess() {
  mockGenerationJobManager.subscribe.mockImplementation((_streamId, _writeEvent, onDone) => {
    process.nextTick(() => onDone({ done: true }));
    return { unsubscribe: jest.fn() };
  });
}

function parseSSEMessages(text) {
  return text
    .trim()
    .split('\n\n')
    .filter(Boolean)
    .map((block) => {
      const lines = block.split('\n');
      const event = lines
        .find((line) => line.startsWith('event:'))
        ?.slice(6)
        .trim();
      const data = lines
        .find((line) => line.startsWith('data:'))
        ?.slice(5)
        .trim();
      return {
        event,
        data: data ? JSON.parse(data) : undefined,
      };
    });
}

function getRouteHandler(path, method = 'get') {
  const layer = agentsRouter.stack.find(
    (entry) => entry.route?.path === path && entry.route.methods?.[method],
  );
  return layer?.route?.stack?.[0]?.handle;
}

function createCanonicalResumeState(overrides = {}) {
  const { userMessage: userMessageOverrides = {}, ...resumeStateOverrides } = overrides;

  return {
    runSteps: [
      {
        id: 'step-1',
        type: 'tool_calls',
        index: 0,
        stepDetails: { type: 'tool_calls', tool_calls: [] },
        usage: null,
      },
    ],
    aggregatedContent: [{ type: 'text', text: 'Hello again' }],
    userMessage: {
      messageId: 'user-msg-1',
      conversationId: 'stream-123',
      text: 'Hello',
      ...userMessageOverrides,
    },
    responseMessageId: 'resp-msg-1',
    conversationId: 'stream-123',
    sender: 'Test Agent',
    ...resumeStateOverrides,
  };
}

function createMockSSEExchange({
  streamId = 'stream-123',
  userId = 'user-123',
  tenantId = 'tenant-a',
  query = { resume: 'true' },
} = {}) {
  const chunks = [];
  const req = {
    params: { streamId },
    query,
    user: { id: userId, tenantId },
    on: jest.fn(),
  };
  const res = {
    writableEnded: false,
    setHeader: jest.fn(),
    flushHeaders: jest.fn(),
    flush: jest.fn(),
    write: jest.fn((chunk) => {
      chunks.push(chunk);
      return true;
    }),
    end: jest.fn(() => {
      res.writableEnded = true;
    }),
  };

  return { chunks, req, res };
}

describe('SSE stream tenant isolation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUserId = 'user-123';
    mockTenantId = undefined;
    mockUaParser.mockImplementation((req, res, next) => next());
  });

  describe('GET /chat/stream/:streamId', () => {
    it('returns 403 when a user from a different tenant accesses a stream', async () => {
      mockUserId = 'user-456';
      mockTenantId = 'tenant-b';

      mockGenerationJobManager.getJob.mockResolvedValue({
        metadata: { userId: 'user-456', tenantId: 'tenant-a' },
        status: 'running',
      });

      const res = await request(app).get('/agents/chat/stream/stream-123');
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Unauthorized');
    });

    it('returns 404 when stream does not exist', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue(null);

      const res = await request(app).get('/agents/chat/stream/nonexistent');
      expect(res.status).toBe(404);
    });

    it('proceeds past tenant guard when tenant matches', async () => {
      mockUserId = 'user-123';
      mockTenantId = 'tenant-a';
      mockSubscribeSuccess();

      mockGenerationJobManager.getJob.mockResolvedValue({
        metadata: { userId: 'user-123', tenantId: 'tenant-a' },
        status: 'running',
      });

      const res = await request(app).get('/agents/chat/stream/stream-123');
      expect(res.status).toBe(200);
      expect(mockGenerationJobManager.subscribe).toHaveBeenCalledTimes(1);
    });

    it('does not run uaParser on the resumable stream route', async () => {
      mockUserId = 'user-123';
      mockTenantId = 'tenant-a';
      mockSubscribeSuccess();
      mockUaParser.mockImplementation(() => {
        throw new Error('uaParser should not run for /chat/stream');
      });

      mockGenerationJobManager.getJob.mockResolvedValue({
        metadata: { userId: 'user-123', tenantId: 'tenant-a' },
        status: 'running',
      });

      const res = await request(app).get('/agents/chat/stream/stream-123');
      expect(res.status).toBe(200);
      expect(mockUaParser).not.toHaveBeenCalled();
    });

    it('proceeds past tenant guard when job has no tenantId (single-tenant mode)', async () => {
      mockUserId = 'user-123';
      mockTenantId = undefined;
      mockSubscribeSuccess();

      mockGenerationJobManager.getJob.mockResolvedValue({
        metadata: { userId: 'user-123' },
        status: 'running',
      });

      const res = await request(app).get('/agents/chat/stream/stream-123');
      expect(res.status).toBe(200);
      expect(mockGenerationJobManager.subscribe).toHaveBeenCalledTimes(1);
    });

    it('emits the canonical sync payload on resume with created, attachment, step, and content pending events', async () => {
      mockUserId = 'user-123';
      mockTenantId = 'tenant-a';

      const resumeState = createCanonicalResumeState();
      const pendingEvents = [
        {
          created: true,
          message: {
            messageId: 'user-msg-1',
            conversationId: 'stream-123',
            text: 'Hello',
          },
        },
        {
          event: 'attachment',
          data: {
            type: 'file',
            messageId: 'resp-msg-1',
          },
        },
        {
          event: 'on_run_step',
          data: {
            id: 'step-2',
            type: 'tool_calls',
          },
        },
        {
          type: 'text',
          text: 'world',
          index: 0,
          messageId: 'resp-msg-1',
          conversationId: 'stream-123',
          userMessageId: 'user-msg-1',
          thread_id: 'stream-123',
        },
      ];

      mockGenerationJobManager.getJob.mockResolvedValue({
        metadata: { userId: 'user-123', tenantId: 'tenant-a' },
        status: 'running',
      });
      mockGenerationJobManager.subscribeWithResume.mockResolvedValue({
        subscription: { unsubscribe: jest.fn() },
        resumeState,
        pendingEvents,
      });

      const { chunks, req, res } = createMockSSEExchange();

      const handler = getRouteHandler('/chat/stream/:streamId');
      expect(typeof handler).toBe('function');

      await handler(req, res);

      expect(mockGenerationJobManager.subscribeWithResume).toHaveBeenCalledTimes(1);
      expect(mockCreateSyncEvent).toHaveBeenCalledWith({ resumeState, pendingEvents });
      expect(mockSendEvent).toHaveBeenCalledTimes(1);
      expect(mockSendEvent.mock.calls[0][0]).toBe(res);
      expect(mockSendEvent.mock.calls[0][1]).toBe(mockCreateSyncEvent.mock.results[0].value);
      expect(mockGenerationJobManager.markSyncSent).toHaveBeenCalledWith('stream-123');
      expect(req.on).toHaveBeenCalledWith('close', expect.any(Function));

      const events = parseSSEMessages(chunks.join(''));
      expect(events[0]).toEqual({
        event: 'message',
        data: {
          sync: true,
          resumeState,
          pendingEvents,
        },
      });
    });

    it('buffers live resume chunks until after the canonical sync payload is sent', async () => {
      mockUserId = 'user-123';
      mockTenantId = 'tenant-a';

      const resumeState = createCanonicalResumeState();
      const liveChunk = {
        event: 'on_run_step',
        data: {
          id: 'step-live-1',
          type: 'tool_calls',
        },
      };

      mockGenerationJobManager.getJob.mockResolvedValue({
        metadata: { userId: 'user-123', tenantId: 'tenant-a' },
        status: 'running',
      });
      mockGenerationJobManager.subscribeWithResume.mockImplementation(
        async (_streamId, onChunk) => {
          onChunk(liveChunk);
          return {
            subscription: { unsubscribe: jest.fn() },
            resumeState,
            pendingEvents: [],
          };
        },
      );

      const { chunks, req, res } = createMockSSEExchange();

      const handler = getRouteHandler('/chat/stream/:streamId');
      expect(typeof handler).toBe('function');

      await handler(req, res);

      expect(parseSSEMessages(chunks.join(''))).toEqual([
        {
          event: 'message',
          data: {
            sync: true,
            resumeState,
            pendingEvents: [],
          },
        },
        {
          event: 'message',
          data: liveChunk,
        },
      ]);
    });

    it('fails in-band instead of replaying pending events when resume state is unavailable', async () => {
      mockUserId = 'user-123';
      mockTenantId = 'tenant-a';

      const pendingEvents = [
        {
          created: true,
          message: {
            messageId: 'user-msg-1',
            conversationId: 'stream-123',
            text: 'Hello',
          },
        },
        {
          type: 'text',
          text: 'world',
          index: 0,
          messageId: 'resp-msg-1',
          conversationId: 'stream-123',
          userMessageId: 'user-msg-1',
          thread_id: 'stream-123',
        },
      ];

      mockGenerationJobManager.getJob.mockResolvedValue({
        metadata: { userId: 'user-123', tenantId: 'tenant-a' },
        status: 'running',
      });
      mockGenerationJobManager.subscribeWithResume.mockResolvedValue({
        subscription: { unsubscribe: jest.fn() },
        resumeState: null,
        pendingEvents,
      });

      const { chunks, req, res } = createMockSSEExchange();

      const handler = getRouteHandler('/chat/stream/:streamId');
      expect(typeof handler).toBe('function');

      await handler(req, res);

      expect(mockCreateSyncEvent).not.toHaveBeenCalled();
      expect(mockGenerationJobManager.markSyncSent).not.toHaveBeenCalled();
      expect(mockCreateFinalErrorEvent).toHaveBeenCalledWith(
        RESUME_SYNC_UNAVAILABLE_MESSAGE,
        RESUME_SYNC_UNAVAILABLE_CODE,
      );
      expect(mockSendEvent).toHaveBeenCalledTimes(1);

      const rawStream = chunks.join('');
      expect(rawStream).not.toContain('"created":true');
      expect(rawStream).not.toContain('"text":"world"');
      expect(rawStream).not.toContain('event: error');
      expect(parseSSEMessages(rawStream)).toEqual([
        {
          event: 'message',
          data: {
            final: true,
            error: {
              message: RESUME_SYNC_UNAVAILABLE_MESSAGE,
              code: RESUME_SYNC_UNAVAILABLE_CODE,
            },
          },
        },
      ]);
    });

    it('fails in-band when stored resume state lacks exact IDs', async () => {
      mockUserId = 'user-123';
      mockTenantId = 'tenant-a';

      const resumeState = createCanonicalResumeState({
        responseMessageId: '',
      });
      const pendingEvents = [
        {
          type: 'text',
          text: 'world',
          index: 0,
          messageId: 'resp-msg-1',
          conversationId: 'stream-123',
          userMessageId: 'user-msg-1',
          thread_id: 'stream-123',
        },
      ];

      mockGenerationJobManager.getJob.mockResolvedValue({
        metadata: { userId: 'user-123', tenantId: 'tenant-a' },
        status: 'running',
      });
      mockGenerationJobManager.subscribeWithResume.mockResolvedValue({
        subscription: { unsubscribe: jest.fn() },
        resumeState,
        pendingEvents,
      });

      const { chunks, req, res } = createMockSSEExchange();

      const handler = getRouteHandler('/chat/stream/:streamId');
      expect(typeof handler).toBe('function');

      await handler(req, res);

      expect(mockCreateSyncEvent).not.toHaveBeenCalled();
      expect(mockGenerationJobManager.markSyncSent).not.toHaveBeenCalled();
      expect(mockCreateFinalErrorEvent).toHaveBeenCalledWith(
        RESUME_SYNC_UNAVAILABLE_MESSAGE,
        RESUME_SYNC_UNAVAILABLE_CODE,
      );
      expect(parseSSEMessages(chunks.join(''))).toEqual([
        {
          event: 'message',
          data: {
            final: true,
            error: {
              message: RESUME_SYNC_UNAVAILABLE_MESSAGE,
              code: RESUME_SYNC_UNAVAILABLE_CODE,
            },
          },
        },
      ]);
    });

    it('fails in-band when pending replay events fall outside the canonical contract', async () => {
      mockUserId = 'user-123';
      mockTenantId = 'tenant-a';

      const resumeState = createCanonicalResumeState();

      mockGenerationJobManager.getJob.mockResolvedValue({
        metadata: { userId: 'user-123', tenantId: 'tenant-a' },
        status: 'running',
      });
      mockGenerationJobManager.subscribeWithResume.mockResolvedValue({
        subscription: { unsubscribe: jest.fn() },
        resumeState,
        pendingEvents: [{ event: 'test', data: { value: 'hello' } }],
      });

      const { chunks, req, res } = createMockSSEExchange();

      const handler = getRouteHandler('/chat/stream/:streamId');
      expect(typeof handler).toBe('function');

      await handler(req, res);

      expect(mockCreateSyncEvent).not.toHaveBeenCalled();
      expect(mockGenerationJobManager.markSyncSent).not.toHaveBeenCalled();
      expect(mockCreateFinalErrorEvent).toHaveBeenCalledWith(
        RESUME_SYNC_UNAVAILABLE_MESSAGE,
        RESUME_SYNC_UNAVAILABLE_CODE,
      );
      expect(parseSSEMessages(chunks.join(''))).toEqual([
        {
          event: 'message',
          data: {
            final: true,
            error: {
              message: RESUME_SYNC_UNAVAILABLE_MESSAGE,
              code: RESUME_SYNC_UNAVAILABLE_CODE,
            },
          },
        },
      ]);
    });

    it('emits the canonical in-band final error payload on the message channel during resume', async () => {
      mockUserId = 'user-123';
      mockTenantId = 'tenant-a';

      mockGenerationJobManager.getJob.mockResolvedValue({
        metadata: { userId: 'user-123', tenantId: 'tenant-a' },
        status: 'running',
      });
      mockGenerationJobManager.subscribeWithResume.mockImplementation(
        async (_streamId, _writeEvent, _onDone, onError) => {
          onError('Generation failed');
          return {
            subscription: { unsubscribe: jest.fn() },
            resumeState: null,
            pendingEvents: [],
          };
        },
      );

      const { chunks, req, res } = createMockSSEExchange();

      const handler = getRouteHandler('/chat/stream/:streamId');
      expect(typeof handler).toBe('function');

      await handler(req, res);

      expect(mockCreateFinalErrorEvent).toHaveBeenCalledWith('Generation failed');
      expect(mockSendEvent).toHaveBeenCalledTimes(1);
      expect(mockSendEvent.mock.calls[0][0]).toBe(res);
      expect(mockSendEvent.mock.calls[0][1]).toBe(mockCreateFinalErrorEvent.mock.results[0].value);
      expect(res.end).toHaveBeenCalledTimes(1);

      const events = parseSSEMessages(chunks.join(''));
      expect(events).toEqual([
        {
          event: 'message',
          data: {
            final: true,
            error: { message: 'Generation failed' },
          },
        },
      ]);
      expect(chunks.join('')).not.toContain('event: error');
    });

    it('returns 403 when job has tenantId but user has no tenantId', async () => {
      mockUserId = 'user-123';
      mockTenantId = undefined;

      mockGenerationJobManager.getJob.mockResolvedValue({
        metadata: { userId: 'user-123', tenantId: 'some-tenant' },
        status: 'running',
      });

      const res = await request(app).get('/agents/chat/stream/stream-123');
      expect(res.status).toBe(403);
    });
  });

  describe('GET /chat/status/:conversationId', () => {
    it('returns 403 when tenant does not match', async () => {
      mockUserId = 'user-123';
      mockTenantId = 'tenant-b';

      mockGenerationJobManager.getJob.mockResolvedValue({
        metadata: { userId: 'user-123', tenantId: 'tenant-a' },
        status: 'running',
      });

      const res = await request(app).get('/agents/chat/status/conv-123');
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Unauthorized');
    });

    it('returns status when tenant matches', async () => {
      mockUserId = 'user-123';
      mockTenantId = 'tenant-a';
      const resumeState = createCanonicalResumeState({
        conversationId: 'conv-123',
        userMessage: {
          conversationId: 'conv-123',
        },
      });

      mockGenerationJobManager.getJob.mockResolvedValue({
        metadata: { userId: 'user-123', tenantId: 'tenant-a' },
        status: 'running',
        createdAt: Date.now(),
      });
      mockGenerationJobManager.getResumeState.mockResolvedValue(resumeState);

      const res = await request(app).get('/agents/chat/status/conv-123');
      expect(res.status).toBe(200);
      expect(res.body.active).toBe(true);
      expect(res.body.aggregatedContent).toEqual(resumeState.aggregatedContent);
      expect(res.body.resumeState).toEqual(resumeState);
      expect(res.body.resumeStateStatus).toBe('available');
      expect(res.body.resumeError).toBeNull();
    });

    it('returns null resumeState when stored resume state lacks exact IDs', async () => {
      mockUserId = 'user-123';
      mockTenantId = 'tenant-a';

      mockGenerationJobManager.getJob.mockResolvedValue({
        metadata: { userId: 'user-123', tenantId: 'tenant-a' },
        status: 'running',
        createdAt: Date.now(),
      });
      mockGenerationJobManager.getResumeState.mockResolvedValue(
        createCanonicalResumeState({
          conversationId: 'conv-123',
          userMessage: {
            conversationId: 'conv-123',
            messageId: '',
          },
        }),
      );

      const res = await request(app).get('/agents/chat/status/conv-123');
      expect(res.status).toBe(200);
      expect(res.body.active).toBe(true);
      expect(res.body.aggregatedContent).toEqual([]);
      expect(res.body.resumeState).toBeNull();
      expect(res.body.resumeStateStatus).toBe('unavailable');
      expect(res.body.resumeError).toEqual({
        code: RESUME_SYNC_UNAVAILABLE_CODE,
        message: RESUME_SYNC_UNAVAILABLE_MESSAGE,
      });
    });
  });

  describe('POST /chat/abort', () => {
    it('returns 403 when tenant does not match', async () => {
      mockUserId = 'user-123';
      mockTenantId = 'tenant-b';

      mockGenerationJobManager.getJob.mockResolvedValue({
        metadata: { userId: 'user-123', tenantId: 'tenant-a' },
        status: 'running',
      });

      const res = await request(app).post('/agents/chat/abort').send({ streamId: 'stream-123' });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Unauthorized');
    });
  });
});
