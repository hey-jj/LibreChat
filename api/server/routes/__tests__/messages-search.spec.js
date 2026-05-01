const express = require('express');
const request = require('supertest');

jest.mock('@librechat/api', () => ({
  unescapeLaTeX: jest.fn((value) => value),
  countTokens: jest.fn().mockResolvedValue(10),
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

jest.mock('~/server/middleware/requireJwtAuth', () => (req, res, next) => next());

jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, res, next) => next(),
  validateMessageReq: (req, res, next) => next(),
}));

const db = require('~/models');
const messagesRouter = require('../messages');

describe('GET /api/messages?search=', () => {
  let app;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.user = { id: 'user-123' };
      next();
    });
    app.use('/api/messages', messagesRouter);
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('propagates nextCursor and pageSize through the shipped search route', async () => {
    db.searchMessages.mockResolvedValue({
      hits: [
        {
          messageId: 'msg-1',
          conversationId: 'convo-1',
          text: 'alpha result',
          rank: 0.9,
        },
        { messageId: 'msg-2', conversationId: 'convo-2', text: 'filtered result' },
      ],
    });
    db.getConvosQueried.mockResolvedValue({
      nextCursor: '2026-04-21T00:00:00.000Z',
      convoMap: {
        'convo-1': { title: 'Alpha', model: 'gpt-4.1' },
      },
    });
    db.getMessages.mockResolvedValue([
      {
        messageId: 'msg-1',
        isCreatedByUser: false,
        endpoint: 'openAI',
        iconURL: 'https://example.com/icon.png',
      },
    ]);

    const response = await request(app).get(
      '/api/messages?search=alpha&cursor=cursor-1&pageSize=2',
    );

    expect(response.status).toBe(200);
    expect(db.searchMessages).toHaveBeenCalledWith(
      'alpha',
      { filter: 'user = "user-123"' },
      true,
    );
    expect(db.getConvosQueried).toHaveBeenCalledWith(
      'user-123',
      [
        { messageId: 'msg-1', conversationId: 'convo-1', text: 'alpha result' },
        { messageId: 'msg-2', conversationId: 'convo-2', text: 'filtered result' },
      ],
      'cursor-1',
      2,
    );
    expect(response.body).toEqual({
      messages: [
        {
          messageId: 'msg-1',
          conversationId: 'convo-1',
          text: 'alpha result',
          searchResult: true,
          title: 'Alpha',
          model: 'gpt-4.1',
          isCreatedByUser: false,
          endpoint: 'openAI',
          iconURL: 'https://example.com/icon.png',
        },
      ],
      nextCursor: '2026-04-21T00:00:00.000Z',
    });
  });

  it('treats pageSize as the conversation window, not the final hit count', async () => {
    db.searchMessages.mockResolvedValue({
      hits: [
        { messageId: 'msg-1', conversationId: 'convo-1', text: 'alpha result' },
        { messageId: 'msg-2', conversationId: 'convo-1', text: 'second alpha result' },
      ],
    });
    db.getConvosQueried.mockResolvedValue({
      nextCursor: '2026-04-21T00:00:00.000Z',
      convoMap: {
        'convo-1': { title: 'Alpha', model: 'gpt-4.1' },
      },
    });
    db.getMessages.mockResolvedValue([
      {
        messageId: 'msg-1',
        isCreatedByUser: false,
        endpoint: 'openAI',
      },
      {
        messageId: 'msg-2',
        isCreatedByUser: false,
        endpoint: 'openAI',
      },
    ]);

    const response = await request(app).get('/api/messages?search=alpha&pageSize=1');

    expect(response.status).toBe(200);
    expect(db.getConvosQueried).toHaveBeenCalledWith(
      'user-123',
      [
        { messageId: 'msg-1', conversationId: 'convo-1', text: 'alpha result' },
        { messageId: 'msg-2', conversationId: 'convo-1', text: 'second alpha result' },
      ],
      null,
      1,
    );
    expect(response.body.messages).toEqual([
      {
        messageId: 'msg-1',
        conversationId: 'convo-1',
        text: 'alpha result',
        searchResult: true,
        title: 'Alpha',
        model: 'gpt-4.1',
        isCreatedByUser: false,
        endpoint: 'openAI',
      },
      {
        messageId: 'msg-2',
        conversationId: 'convo-1',
        text: 'second alpha result',
        searchResult: true,
        title: 'Alpha',
        model: 'gpt-4.1',
        isCreatedByUser: false,
        endpoint: 'openAI',
      },
    ]);
    expect(response.body.nextCursor).toBe('2026-04-21T00:00:00.000Z');
    expect(response.body.messages).toHaveLength(2);
  });

  it('drops hits that cannot be reconciled to a shipped db message', async () => {
    db.searchMessages.mockResolvedValue({
      hits: [
        { messageId: 'msg-1', conversationId: 'convo-1', text: 'alpha result' },
        { messageId: 'msg-missing', conversationId: 'convo-1', text: 'missing db record' },
      ],
    });
    db.getConvosQueried.mockResolvedValue({
      nextCursor: null,
      convoMap: {
        'convo-1': { title: 'Alpha', model: 'gpt-4.1' },
      },
    });
    db.getMessages.mockResolvedValue([
      {
        messageId: 'msg-1',
        isCreatedByUser: false,
        endpoint: 'openAI',
      },
    ]);

    const response = await request(app).get('/api/messages?search=alpha');

    expect(response.status).toBe(200);
    expect(response.body.messages).toEqual([
      {
        messageId: 'msg-1',
        conversationId: 'convo-1',
        text: 'alpha result',
        searchResult: true,
        title: 'Alpha',
        model: 'gpt-4.1',
        isCreatedByUser: false,
        endpoint: 'openAI',
      },
    ]);
  });
});
