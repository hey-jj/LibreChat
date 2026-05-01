const express = require('express');
const request = require('supertest');
const { ContentTypes } = require('librechat-data-provider');

jest.mock('@librechat/api', () => ({
  unescapeLaTeX: jest.fn((value) => value),
  countTokens: jest.fn(),
}));

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock('librechat-data-provider', () => ({
  ...jest.requireActual('librechat-data-provider'),
}));

jest.mock('~/models', () => ({
  saveConvo: jest.fn(),
  getConvo: jest.fn(),
  getMessage: jest.fn(),
  saveMessage: jest.fn(),
  getMessages: jest.fn(),
  updateMessage: jest.fn(),
  deleteMessages: jest.fn(),
  getConvosQueried: jest.fn(),
  searchMessages: jest.fn(),
  getMessagesByCursor: jest.fn(),
}));

jest.mock('~/server/services/Artifacts/update', () => ({
  findAllArtifacts: jest.fn(),
  replaceArtifactContent: jest.fn(),
}));

jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, res, next) => next(),
  validateMessageReq: jest.requireActual('~/server/middleware/validateMessageReq'),
}));

const db = require('~/models');
const { countTokens } = require('@librechat/api');
const { findAllArtifacts, replaceArtifactContent } = require('~/server/services/Artifacts/update');
const messagesRouter = require('../messages');

describe('messages router write path hardening', () => {
  const authenticatedUserId = 'user-owner-123';
  let app;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.user = { id: authenticatedUserId };
      next();
    });
    app.use('/api/messages', messagesRouter);
  });

  beforeEach(() => {
    jest.clearAllMocks();

    db.getConvo.mockImplementation(async (userId, conversationId) =>
      conversationId ? { conversationId, user: userId } : null,
    );
    db.saveMessage.mockImplementation(async (_reqCtx, message) => ({ ...message }));
    db.saveConvo.mockResolvedValue(undefined);
    db.updateMessage.mockImplementation(async (_userId, payload) => ({ ...payload }));
    db.getMessages.mockResolvedValue([]);
    db.getMessage.mockResolvedValue(null);

    countTokens.mockResolvedValue(10);
    findAllArtifacts.mockReturnValue([]);
    replaceArtifactContent.mockReturnValue(null);
  });

  describe('POST /api/messages/:conversationId', () => {
    it('persists the path conversationId when the body conversationId drifts', async () => {
      const response = await request(app).post('/api/messages/convo-path').send({
        conversationId: 'convo-body',
        messageId: 'msg-1',
        text: 'hello world',
      });

      expect(response.status).toBe(201);
      expect(db.getConvo).toHaveBeenCalledWith(authenticatedUserId, 'convo-path');
      expect(db.saveMessage).toHaveBeenCalledWith(
        expect.objectContaining({ userId: authenticatedUserId }),
        expect.objectContaining({
          conversationId: 'convo-path',
          messageId: 'msg-1',
          text: 'hello world',
          user: authenticatedUserId,
        }),
        { context: 'POST /api/messages/:conversationId' },
      );
      expect(db.saveConvo).toHaveBeenCalledWith(
        expect.objectContaining({ userId: authenticatedUserId }),
        expect.objectContaining({ conversationId: 'convo-path' }),
        { context: 'POST /api/messages/:conversationId' },
      );
      expect(response.body.conversationId).toBe('convo-path');
    });

    it('rejects when only the body conversationId resolves and the path conversationId does not', async () => {
      db.getConvo.mockImplementation(async (_userId, conversationId) => {
        if (conversationId === 'convo-body') {
          return { conversationId, user: authenticatedUserId };
        }
        return null;
      });

      const response = await request(app).post('/api/messages/convo-path').send({
        conversationId: 'convo-body',
        messageId: 'msg-1',
        text: 'hello world',
      });

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'Conversation not found' });
      expect(db.getConvo).toHaveBeenCalledWith(authenticatedUserId, 'convo-path');
      expect(db.saveMessage).not.toHaveBeenCalled();
      expect(db.saveConvo).not.toHaveBeenCalled();
    });
  });

  describe('PUT /api/messages/:conversationId/:messageId', () => {
    it('passes conversationId into a simple text update write', async () => {
      countTokens.mockResolvedValueOnce(42);
      db.updateMessage.mockResolvedValue({
        conversationId: 'convo-simple',
        messageId: 'msg-simple',
        text: 'updated text',
        tokenCount: 42,
      });

      const response = await request(app).put('/api/messages/convo-simple/msg-simple').send({
        text: 'updated text',
        model: 'gpt-test',
      });

      expect(response.status).toBe(200);
      expect(db.getConvo).toHaveBeenCalledWith(authenticatedUserId, 'convo-simple');
      expect(db.updateMessage).toHaveBeenCalledWith(authenticatedUserId, {
        conversationId: 'convo-simple',
        messageId: 'msg-simple',
        text: 'updated text',
        tokenCount: 42,
      });
      expect(response.body).toEqual({
        conversationId: 'convo-simple',
        messageId: 'msg-simple',
        text: 'updated text',
        tokenCount: 42,
      });
    });

    it('scopes indexed edits by user during lookup and writes back with conversationId', async () => {
      db.getMessages.mockResolvedValue([
        {
          content: [{ type: ContentTypes.TEXT, text: 'old text' }],
          tokenCount: 100,
        },
      ]);
      countTokens.mockResolvedValueOnce(3).mockResolvedValueOnce(5);
      db.updateMessage.mockResolvedValue({
        conversationId: 'convo-indexed',
        messageId: 'msg-indexed',
      });

      const response = await request(app).put('/api/messages/convo-indexed/msg-indexed').send({
        text: 'new text',
        index: 0,
        model: 'gpt-test',
      });

      expect(response.status).toBe(200);
      expect(db.getConvo).toHaveBeenCalledWith(authenticatedUserId, 'convo-indexed');
      expect(db.getMessages).toHaveBeenCalledWith(
        {
          conversationId: 'convo-indexed',
          messageId: 'msg-indexed',
          user: authenticatedUserId,
        },
        'content tokenCount',
      );
      expect(db.updateMessage).toHaveBeenCalledWith(authenticatedUserId, {
        conversationId: 'convo-indexed',
        messageId: 'msg-indexed',
        content: [{ type: ContentTypes.TEXT, text: 'new text' }],
        tokenCount: 102,
      });
      expect(response.body).toEqual({
        conversationId: 'convo-indexed',
        messageId: 'msg-indexed',
      });
    });
  });

  describe('PUT /api/messages/:conversationId/:messageId/feedback', () => {
    it('passes conversationId into the feedback update write', async () => {
      db.updateMessage.mockResolvedValue({ feedback: 'thumbs-up' });

      const response = await request(app)
        .put('/api/messages/convo-feedback/msg-feedback/feedback')
        .send({ feedback: 'thumbs-up' });

      expect(response.status).toBe(200);
      expect(db.getConvo).toHaveBeenCalledWith(authenticatedUserId, 'convo-feedback');
      expect(db.updateMessage).toHaveBeenCalledWith(
        authenticatedUserId,
        {
          conversationId: 'convo-feedback',
          messageId: 'msg-feedback',
          feedback: 'thumbs-up',
        },
        { context: 'updateFeedback' },
      );
      expect(response.body).toEqual({
        messageId: 'msg-feedback',
        conversationId: 'convo-feedback',
        feedback: 'thumbs-up',
      });
    });
  });

  describe('POST /api/messages/branch', () => {
    it('creates a branch message through the mounted router', async () => {
      db.getMessage.mockResolvedValue({
        messageId: 'msg-source',
        conversationId: 'convo-branch',
        parentMessageId: 'msg-parent',
        attachments: [{ file_id: 'file-1' }],
        isCreatedByUser: false,
        model: 'gpt-test',
        endpoint: 'openAI',
        sender: 'assistant',
        iconURL: 'https://example.com/icon.png',
        content: [
          { type: ContentTypes.TEXT, text: 'skip me', agentId: 'agent-1', groupId: 'group-1' },
          { type: ContentTypes.TEXT, text: 'keep me', agentId: 'agent-2', groupId: 'group-1' },
        ],
      });
      db.saveMessage.mockImplementation(async (_reqCtx, message) => ({ ...message }));

      const response = await request(app).post('/api/messages/branch').send({
        messageId: 'msg-source',
        agentId: 'agent-2',
      });

      expect(response.status).toBe(201);
      expect(db.getMessage).toHaveBeenCalledWith({
        user: authenticatedUserId,
        messageId: 'msg-source',
      });
      expect(db.saveMessage).toHaveBeenCalledWith(
        expect.objectContaining({ userId: authenticatedUserId }),
        expect.objectContaining({
          messageId: expect.any(String),
          conversationId: 'convo-branch',
          parentMessageId: 'msg-parent',
          attachments: [{ file_id: 'file-1' }],
          endpoint: 'openAI',
          sender: 'assistant',
          user: authenticatedUserId,
          content: [{ type: ContentTypes.TEXT, text: 'keep me' }],
        }),
        { context: 'POST /api/messages/branch' },
      );
      expect(response.body.conversationId).toBe('convo-branch');
      expect(response.body.content).toEqual([{ type: ContentTypes.TEXT, text: 'keep me' }]);
    });
  });

  describe('POST /api/messages/artifact/:messageId', () => {
    it('edits an artifact through the mounted router', async () => {
      const artifact = { source: 'text', index: 0 };

      db.getMessage.mockResolvedValue({
        messageId: 'msg-artifact',
        conversationId: 'convo-artifact',
        text: 'artifact before',
        content: [],
      });
      findAllArtifacts.mockReturnValue([artifact]);
      replaceArtifactContent.mockReturnValue('artifact after');
      db.saveMessage.mockImplementation(async (_reqCtx, message) => ({ ...message }));

      const response = await request(app).post('/api/messages/artifact/msg-artifact').send({
        index: 0,
        original: 'artifact before',
        updated: 'artifact after',
      });

      expect(response.status).toBe(200);
      expect(db.getMessage).toHaveBeenCalledWith({
        user: authenticatedUserId,
        messageId: 'msg-artifact',
      });
      expect(findAllArtifacts).toHaveBeenCalledWith(
        expect.objectContaining({
          messageId: 'msg-artifact',
          conversationId: 'convo-artifact',
        }),
      );
      expect(replaceArtifactContent).toHaveBeenCalledWith(
        'artifact before',
        artifact,
        'artifact before',
        'artifact after',
      );
      expect(db.saveMessage).toHaveBeenCalledWith(
        expect.objectContaining({ userId: authenticatedUserId }),
        {
          messageId: 'msg-artifact',
          conversationId: 'convo-artifact',
          text: 'artifact after',
          content: [],
          user: authenticatedUserId,
        },
        { context: 'POST /api/messages/artifact/:messageId' },
      );
      expect(response.body).toEqual({
        conversationId: 'convo-artifact',
        content: [],
        text: 'artifact after',
      });
    });
  });
});
