/**
 * Unit tests for Open Responses API controller
 * Tests that recordCollectedUsage is called correctly for token spending
 */

const mockSpendTokens = jest.fn().mockResolvedValue({});
const mockSpendStructuredTokens = jest.fn().mockResolvedValue({});
const mockRecordCollectedUsage = jest
  .fn()
  .mockResolvedValue({ input_tokens: 100, output_tokens: 50 });
const mockGetBalanceConfig = jest.fn().mockReturnValue({ enabled: true });
const mockGetTransactionsConfig = jest.fn().mockReturnValue({ enabled: true });

jest.mock('nanoid', () => ({
  nanoid: jest.fn(() => 'mock-nanoid-123'),
}));

jest.mock('uuid', () => ({
  v4: jest.fn(() => 'mock-uuid-456'),
}));

jest.mock('@librechat/data-schemas', () => ({
  logger: {
    debug: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  },
}));

jest.mock('@librechat/agents', () => ({
  Callback: { TOOL_ERROR: 'TOOL_ERROR' },
  ToolEndHandler: jest.fn(),
  formatAgentMessages: jest.fn().mockReturnValue({
    messages: [],
    indexTokenCountMap: {},
  }),
}));

jest.mock('@librechat/api', () => ({
  createRun: jest.fn().mockResolvedValue({
    processStream: jest.fn().mockResolvedValue(undefined),
  }),
  buildToolSet: jest.fn().mockReturnValue(new Set()),
  createSafeUser: jest.fn().mockReturnValue({ id: 'user-123' }),
  initializeAgent: jest.fn().mockResolvedValue({
    id: 'agent-123',
    model: 'claude-3',
    model_parameters: {},
    toolRegistry: {},
    edges: [],
  }),
  discoverConnectedAgents: jest.fn().mockResolvedValue({
    agentConfigs: new Map(),
    edges: [],
    skippedAgentIds: new Set(),
    userMCPAuthMap: undefined,
  }),
  getBalanceConfig: mockGetBalanceConfig,
  getTransactionsConfig: mockGetTransactionsConfig,
  recordCollectedUsage: mockRecordCollectedUsage,
  createToolExecuteHandler: jest.fn().mockReturnValue({ handle: jest.fn() }),
  // Responses API
  writeDone: jest.fn(),
  buildResponse: jest.fn().mockReturnValue({ id: 'resp_123', output: [] }),
  generateResponseId: jest.fn().mockReturnValue('resp_mock-123'),
  isValidationFailure: jest.fn().mockReturnValue(false),
  emitResponseCreated: jest.fn(),
  createResponseContext: jest.fn().mockReturnValue({ responseId: 'resp_123' }),
  createResponseTracker: jest.fn().mockReturnValue({
    usage: { promptTokens: 100, completionTokens: 50 },
  }),
  setupStreamingResponse: jest.fn(),
  emitResponseInProgress: jest.fn(),
  convertInputToMessages: jest.fn().mockReturnValue([]),
  validateResponseRequest: jest.fn().mockReturnValue({
    request: { model: 'agent-123', input: 'Hello', stream: false },
  }),
  buildAggregatedResponse: jest.fn().mockReturnValue({
    id: 'resp_123',
    status: 'completed',
    output: [],
    usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
  }),
  createResponseAggregator: jest.fn().mockReturnValue({
    usage: { promptTokens: 100, completionTokens: 50 },
  }),
  sendResponsesErrorResponse: jest.fn(),
  createResponsesEventHandlers: jest.fn().mockReturnValue({
    handlers: {
      on_message_delta: { handle: jest.fn() },
      on_reasoning_delta: { handle: jest.fn() },
      on_run_step: { handle: jest.fn() },
      on_run_step_delta: { handle: jest.fn() },
      on_chat_model_end: { handle: jest.fn() },
    },
    finalizeStream: jest.fn(),
  }),
  createAggregatorEventHandlers: jest.fn().mockReturnValue({
    on_message_delta: { handle: jest.fn() },
    on_reasoning_delta: { handle: jest.fn() },
    on_run_step: { handle: jest.fn() },
    on_run_step_delta: { handle: jest.fn() },
    on_chat_model_end: { handle: jest.fn() },
  }),
}));

jest.mock('~/server/services/ToolService', () => ({
  loadAgentTools: jest.fn().mockResolvedValue([]),
  loadToolsForExecution: jest.fn().mockResolvedValue([]),
}));

const mockGetMultiplier = jest.fn().mockReturnValue(1);
const mockGetCacheMultiplier = jest.fn().mockReturnValue(null);

jest.mock('~/server/controllers/agents/callbacks', () => {
  const noop = { handle: jest.fn() };
  return {
    createToolEndCallback: jest.fn().mockReturnValue(jest.fn()),
    createResponsesToolEndCallback: jest.fn().mockReturnValue(jest.fn()),
    markSummarizationUsage: jest.fn().mockImplementation((usage) => usage),
    agentLogHandlerObj: noop,
    buildSummarizationHandlers: jest.fn().mockReturnValue({
      on_summarize_start: noop,
      on_summarize_delta: noop,
      on_summarize_complete: noop,
    }),
  };
});

jest.mock('~/server/services/PermissionService', () => ({
  findAccessibleResources: jest.fn().mockResolvedValue([]),
  checkPermission: jest.fn().mockResolvedValue(true),
}));

jest.mock('~/server/controllers/ModelController', () => ({
  getModelsConfig: jest.fn().mockResolvedValue({}),
}));

jest.mock('~/server/services/Files/permissions', () => ({
  filterFilesByAgentAccess: jest.fn(),
}));

jest.mock('~/cache', () => ({
  logViolation: jest.fn(),
}));

const mockUpdateBalance = jest.fn().mockResolvedValue({});
const mockBulkInsertTransactions = jest.fn().mockResolvedValue(undefined);

jest.mock('~/models', () => ({
  getAgent: jest.fn().mockResolvedValue({ id: 'agent-123', name: 'Test Agent' }),
  getFiles: jest.fn(),
  getUserKey: jest.fn(),
  getMessage: jest.fn().mockResolvedValue(null),
  getMessages: jest.fn().mockResolvedValue([]),
  saveMessage: jest.fn().mockResolvedValue({}),
  updateFilesUsage: jest.fn(),
  getUserKeyValues: jest.fn(),
  getUserCodeFiles: jest.fn(),
  getToolFilesByIds: jest.fn(),
  getCodeGeneratedFiles: jest.fn(),
  updateBalance: mockUpdateBalance,
  bulkInsertTransactions: mockBulkInsertTransactions,
  spendTokens: mockSpendTokens,
  spendStructuredTokens: mockSpendStructuredTokens,
  getMultiplier: mockGetMultiplier,
  getCacheMultiplier: mockGetCacheMultiplier,
  getConvoFiles: jest.fn().mockResolvedValue([]),
  saveConvo: jest.fn().mockResolvedValue({}),
  getConvo: jest.fn().mockResolvedValue(null),
}));

describe('createResponse controller', () => {
  let createResponse;
  let req, res;

  beforeEach(() => {
    jest.clearAllMocks();

    const controller = require('../responses');
    createResponse = controller.createResponse;

    req = {
      body: {
        model: 'agent-123',
        input: 'Hello',
        stream: false,
      },
      user: { id: 'user-123' },
      config: {
        endpoints: {
          agents: { allowedProviders: ['anthropic'] },
        },
      },
      on: jest.fn(),
    };

    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
      setHeader: jest.fn(),
      flushHeaders: jest.fn(),
      end: jest.fn(),
      write: jest.fn(),
    };
  });

  describe('conversation ownership validation', () => {
    it('should skip ownership check when previous_response_id is not provided', async () => {
      const { getConvo, getMessage } = require('~/models');
      await createResponse(req, res);
      expect(getMessage).not.toHaveBeenCalled();
      expect(getConvo).not.toHaveBeenCalled();
    });

    it('should return 400 when previous_response_id is not a string', async () => {
      const { validateResponseRequest, sendResponsesErrorResponse } = require('@librechat/api');
      validateResponseRequest.mockReturnValueOnce({
        request: {
          model: 'agent-123',
          input: 'Hello',
          stream: false,
          previous_response_id: { $gt: '' },
        },
      });

      await createResponse(req, res);
      expect(sendResponsesErrorResponse).toHaveBeenCalledWith(
        res,
        400,
        'previous_response_id must be a string',
        'invalid_request',
      );
    });

    it('should return 404 when previous response is not owned by user', async () => {
      const { validateResponseRequest, sendResponsesErrorResponse } = require('@librechat/api');
      const { getConvo, getMessage } = require('~/models');
      validateResponseRequest.mockReturnValueOnce({
        request: {
          model: 'agent-123',
          input: 'Hello',
          stream: false,
          previous_response_id: 'resp_abc',
        },
      });
      getMessage.mockResolvedValueOnce(null);

      await createResponse(req, res);
      expect(getMessage).toHaveBeenCalledWith({ user: 'user-123', messageId: 'resp_abc' });
      expect(getConvo).not.toHaveBeenCalled();
      expect(sendResponsesErrorResponse).toHaveBeenCalledWith(
        res,
        404,
        'Previous response not found: resp_abc',
        'not_found',
        'response_not_found',
      );
    });

    it('should proceed when previous response resolves to a stored conversation', async () => {
      const { validateResponseRequest, sendResponsesErrorResponse } = require('@librechat/api');
      const { getConvo, getMessage, getMessages } = require('~/models');
      validateResponseRequest.mockReturnValueOnce({
        request: {
          model: 'agent-123',
          input: 'Hello',
          stream: false,
          previous_response_id: 'resp_abc',
        },
      });
      getMessage.mockResolvedValueOnce({
        conversationId: 'mock-uuid-456',
        isCreatedByUser: false,
        metadata: {
          response_snapshot: { id: 'resp_abc', object: 'response' },
        },
      });

      await createResponse(req, res);
      expect(getMessage).toHaveBeenCalledWith({ user: 'user-123', messageId: 'resp_abc' });
      expect(getConvo).not.toHaveBeenCalled();
      expect(getMessages).toHaveBeenCalledWith({
        conversationId: 'mock-uuid-456',
        user: 'user-123',
      });
      expect(sendResponsesErrorResponse).not.toHaveBeenCalledWith(
        res,
        404,
        expect.any(String),
        expect.any(String),
      );
    });

    it('should return 409 when previous response lacks an exact snapshot', async () => {
      const { validateResponseRequest, sendResponsesErrorResponse } = require('@librechat/api');
      const { getMessage } = require('~/models');
      validateResponseRequest.mockReturnValueOnce({
        request: {
          model: 'agent-123',
          input: 'Hello',
          stream: false,
          previous_response_id: 'resp_legacy',
        },
      });
      getMessage.mockResolvedValueOnce({
        conversationId: 'mock-uuid-456',
        isCreatedByUser: false,
        metadata: {},
      });

      await createResponse(req, res);

      expect(sendResponsesErrorResponse).toHaveBeenCalledWith(
        res,
        409,
        'Stored response resp_legacy does not include an exact persisted snapshot; this legacy record cannot be used as previous_response_id.',
        'invalid_state',
        'response_snapshot_unavailable',
      );
    });

    it('should return 500 when getMessage throws a DB error for a response reference', async () => {
      const { validateResponseRequest, sendResponsesErrorResponse } = require('@librechat/api');
      const { getConvo, getMessage } = require('~/models');
      validateResponseRequest.mockReturnValueOnce({
        request: {
          model: 'agent-123',
          input: 'Hello',
          stream: false,
          previous_response_id: 'resp_abc',
        },
      });
      getMessage.mockRejectedValueOnce(new Error('DB connection failed'));

      await createResponse(req, res);
      expect(getMessage).toHaveBeenCalledWith({ user: 'user-123', messageId: 'resp_abc' });
      expect(getConvo).not.toHaveBeenCalled();
      expect(sendResponsesErrorResponse).toHaveBeenCalledWith(
        res,
        500,
        expect.any(String),
        expect.any(String),
      );
    });
  });

  describe('token usage recording - non-streaming', () => {
    it('should call recordCollectedUsage after successful non-streaming completion', async () => {
      await createResponse(req, res);

      expect(mockRecordCollectedUsage).toHaveBeenCalledTimes(1);
      expect(mockRecordCollectedUsage).toHaveBeenCalledWith(
        {
          spendTokens: mockSpendTokens,
          spendStructuredTokens: mockSpendStructuredTokens,
          pricing: { getMultiplier: mockGetMultiplier, getCacheMultiplier: mockGetCacheMultiplier },
          bulkWriteOps: {
            insertMany: mockBulkInsertTransactions,
            updateBalance: mockUpdateBalance,
          },
        },
        expect.objectContaining({
          user: 'user-123',
          conversationId: expect.any(String),
          collectedUsage: expect.any(Array),
          context: 'message',
        }),
      );
    });

    it('should pass balance and transactions config to recordCollectedUsage', async () => {
      mockGetBalanceConfig.mockReturnValue({ enabled: true, startBalance: 2000 });
      mockGetTransactionsConfig.mockReturnValue({ enabled: true });

      await createResponse(req, res);

      expect(mockRecordCollectedUsage).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          balance: { enabled: true, startBalance: 2000 },
          transactions: { enabled: true },
        }),
      );
    });

    it('should pass spendTokens, spendStructuredTokens, pricing, and bulkWriteOps as dependencies', async () => {
      await createResponse(req, res);

      const [deps] = mockRecordCollectedUsage.mock.calls[0];
      expect(deps).toHaveProperty('spendTokens', mockSpendTokens);
      expect(deps).toHaveProperty('spendStructuredTokens', mockSpendStructuredTokens);
      expect(deps).toHaveProperty('pricing');
      expect(deps.pricing).toHaveProperty('getMultiplier', mockGetMultiplier);
      expect(deps.pricing).toHaveProperty('getCacheMultiplier', mockGetCacheMultiplier);
      expect(deps).toHaveProperty('bulkWriteOps');
      expect(deps.bulkWriteOps).toHaveProperty('insertMany', mockBulkInsertTransactions);
      expect(deps.bulkWriteOps).toHaveProperty('updateBalance', mockUpdateBalance);
    });

    it('should include model from primaryConfig in recordCollectedUsage params', async () => {
      await createResponse(req, res);

      expect(mockRecordCollectedUsage).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          model: 'claude-3',
        }),
      );
    });
  });

  describe('token usage recording - streaming', () => {
    beforeEach(() => {
      req.body.stream = true;

      const api = require('@librechat/api');
      api.validateResponseRequest.mockReturnValue({
        request: { model: 'agent-123', input: 'Hello', stream: true },
      });
    });

    it('should call recordCollectedUsage after successful streaming completion', async () => {
      await createResponse(req, res);

      expect(mockRecordCollectedUsage).toHaveBeenCalledTimes(1);
      expect(mockRecordCollectedUsage).toHaveBeenCalledWith(
        {
          spendTokens: mockSpendTokens,
          spendStructuredTokens: mockSpendStructuredTokens,
          pricing: { getMultiplier: mockGetMultiplier, getCacheMultiplier: mockGetCacheMultiplier },
          bulkWriteOps: {
            insertMany: mockBulkInsertTransactions,
            updateBalance: mockUpdateBalance,
          },
        },
        expect.objectContaining({
          user: 'user-123',
          context: 'message',
        }),
      );
    });
  });

  describe('collectedUsage population', () => {
    it('should collect usage from on_chat_model_end events', async () => {
      const api = require('@librechat/api');

      api.createRun.mockImplementation(async ({ customHandlers }) => {
        return {
          processStream: jest.fn().mockImplementation(async () => {
            customHandlers.on_chat_model_end.handle('on_chat_model_end', {
              output: {
                usage_metadata: {
                  input_tokens: 150,
                  output_tokens: 75,
                  model: 'claude-3',
                },
              },
            });
          }),
        };
      });

      await createResponse(req, res);
      expect(mockRecordCollectedUsage).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          collectedUsage: expect.arrayContaining([
            expect.objectContaining({
              input_tokens: 150,
              output_tokens: 75,
            }),
          ]),
        }),
      );
    });
  });
});

describe('getResponse controller', () => {
  let getResponse;
  let req, res;

  beforeEach(() => {
    jest.clearAllMocks();

    const controller = require('../responses');
    getResponse = controller.getResponse;

    req = {
      params: { id: 'resp_123' },
      user: { id: 'user-123' },
    };

    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
  });

  it('should return a stored response snapshot from message metadata', async () => {
    const { getMessage } = require('~/models');
    const { sendResponsesErrorResponse } = require('@librechat/api');
    const storedSnapshot = {
      id: 'resp_123',
      status: 'completed',
      output: [
        {
          type: 'message',
          content: [{ type: 'output_text', text: 'Hello from the stored snapshot' }],
        },
      ],
    };

    getMessage.mockResolvedValueOnce({
      isCreatedByUser: false,
      metadata: {
        response_snapshot: storedSnapshot,
      },
    });

    await getResponse(req, res);

    expect(getMessage).toHaveBeenCalledWith({ user: 'user-123', messageId: 'resp_123' });
    expect(res.json).toHaveBeenCalledWith(storedSnapshot);
    expect(sendResponsesErrorResponse).not.toHaveBeenCalled();
  });

  it('should return a truthful error when a legacy stored response lacks an exact snapshot', async () => {
    const { getMessage } = require('~/models');
    const { sendResponsesErrorResponse } = require('@librechat/api');

    req.params.id = 'resp_legacy';
    getMessage.mockResolvedValueOnce({
      isCreatedByUser: false,
      metadata: {},
    });

    await getResponse(req, res);

    expect(getMessage).toHaveBeenCalledWith({ user: 'user-123', messageId: 'resp_legacy' });
    expect(sendResponsesErrorResponse).toHaveBeenCalledWith(
      res,
      409,
      'Stored response resp_legacy does not include an exact persisted snapshot; this legacy record cannot be returned truthfully.',
      'invalid_state',
      'response_snapshot_unavailable',
    );
  });
});
