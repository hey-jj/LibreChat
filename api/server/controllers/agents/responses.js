const { nanoid } = require('nanoid');
const { v4: uuidv4 } = require('uuid');
const { logger } = require('@librechat/data-schemas');
const { Callback, ToolEndHandler, formatAgentMessages } = require('@librechat/agents');
const {
  EModelEndpoint,
  ResourceType,
  PermissionBits,
  hasPermissions,
  AgentCapabilities,
} = require('librechat-data-provider');
const {
  createRun,
  buildToolSet,
  loadSkillStates,
  resolveAgentScopedSkillIds,
  createSafeUser,
  initializeAgent,
  getBalanceConfig,
  recordCollectedUsage,
  getTransactionsConfig,
  extractManualSkills,
  injectSkillPrimes,
  createToolExecuteHandler,
  discoverConnectedAgents,
  getRemoteAgentPermissions,
  // Responses API
  writeDone,
  buildResponse,
  generateResponseId,
  isValidationFailure,
  emitResponseCreated,
  createResponseContext,
  createResponseTracker,
  setupStreamingResponse,
  emitResponseFailed,
  emitResponseInProgress,
  emitResponseCompleted,
  convertInputToMessages,
  validateResponseRequest,
  buildAggregatedResponse,
  createResponseAggregator,
  sendResponsesErrorResponse,
  createResponsesEventHandlers,
  createAggregatorEventHandlers,
} = require('@librechat/api');
const {
  createResponsesToolEndCallback,
  buildSummarizationHandlers,
  markSummarizationUsage,
  createToolEndCallback,
  agentLogHandlerObj,
} = require('~/server/controllers/agents/callbacks');
const { loadAgentTools, loadToolsForExecution } = require('~/server/services/ToolService');
const {
  findAccessibleResources,
  getEffectivePermissions,
} = require('~/server/services/PermissionService');
const {
  getSkillToolDeps,
  enrichWithSkillConfigurable,
  buildSkillPrimedIdsByName,
} = require('~/server/services/Endpoints/agents/skillDeps');
const { getModelsConfig } = require('~/server/controllers/ModelController');
const { logViolation } = require('~/cache');
const db = require('~/models');

const RESPONSE_SNAPSHOT_METADATA_KEY = 'response_snapshot';

/**
 * Build the request context used for message persistence.
 * @param {import('express').Request} req
 * @returns {{ userId: string | undefined, isTemporary: boolean | undefined, interfaceConfig: unknown }}
 */
function createSaveMessageContext(req) {
  return {
    userId: req?.user?.id,
    isTemporary: req?.body?.isTemporary,
    interfaceConfig: req?.config?.interfaceConfig,
  };
}

/**
 * Return the exact stored response snapshot for an assistant message if present.
 * @param {{ metadata?: Record<string, unknown> } | null | undefined} message
 * @returns {import('@librechat/api').Response | null}
 */
function getStoredResponseSnapshot(message) {
  const snapshot = message?.metadata?.[RESPONSE_SNAPSHOT_METADATA_KEY];
  if (snapshot == null || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return null;
  }

  return snapshot;
}

/**
 * Store defaults to true per the OpenAI Responses API contract.
 * @param {import('@librechat/api').ResponseRequest} request
 * @returns {boolean}
 */
function shouldStoreResponse(request) {
  return request.store !== false;
}

/**
 * Creates a tool loader function for the agent.
 * @param {AbortSignal} signal - The abort signal
 * @param {boolean} [definitionsOnly=true] - When true, returns only serializable
 *   tool definitions without creating full tool instances (for event-driven mode)
 */
function createToolLoader(signal, definitionsOnly = true) {
  return async function loadTools({
    req,
    res,
    tools,
    model,
    agentId,
    provider,
    tool_options,
    tool_resources,
  }) {
    const agent = { id: agentId, tools, provider, model, tool_options };
    try {
      return await loadAgentTools({
        req,
        res,
        agent,
        signal,
        tool_resources,
        definitionsOnly,
        streamId: null,
      });
    } catch (error) {
      logger.error('Error loading tools for agent ' + agentId, error);
    }
  };
}

/**
 * Convert Open Responses input items to internal messages
 * @param {import('@librechat/api').InputItem[]} input
 * @returns {Array} Internal messages
 */
function convertToInternalMessages(input) {
  return convertInputToMessages(input);
}

/**
 * Load messages from a previous response/conversation
 * @param {string} conversationId - The conversation/response ID
 * @param {string} userId - The user ID
 * @returns {Promise<Array>} Messages from the conversation
 */
async function loadPreviousMessages(conversationId, userId) {
  try {
    const messages = await db.getMessages({ conversationId, user: userId });
    if (!messages || messages.length === 0) {
      return [];
    }

    // Convert stored messages to internal format
    return messages.map((msg) => {
      const internalMsg = {
        role: msg.isCreatedByUser ? 'user' : 'assistant',
        content: '',
        messageId: msg.messageId,
      };

      // Handle content - could be string or array
      if (Array.isArray(msg.content)) {
        internalMsg.content = msg.content;
      } else if (typeof msg.text === 'string') {
        internalMsg.content = msg.text;
      } else if (msg.text) {
        internalMsg.content = String(msg.text);
      }

      return internalMsg;
    });
  } catch (error) {
    logger.error('[Responses API] Error loading previous messages:', error);
    return [];
  }
}

/**
 * Save input messages to database
 * @param {import('express').Request} req
 * @param {string} conversationId
 * @param {Array} inputMessages - Internal format messages
 * @param {string} agentId
 * @returns {Promise<void>}
 */
async function saveInputMessages(req, conversationId, inputMessages, agentId) {
  const saveContext = createSaveMessageContext(req);

  for (const msg of inputMessages) {
    if (msg.role === 'user') {
      await db.saveMessage(
        saveContext,
        {
          messageId: msg.messageId || nanoid(),
          conversationId,
          parentMessageId: null,
          isCreatedByUser: true,
          text: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
          ...(Array.isArray(msg.content) ? { content: msg.content } : {}),
          sender: 'User',
          endpoint: EModelEndpoint.agents,
          model: agentId,
        },
        { context: 'Responses API - save user input' },
      );
    }
  }
}

/**
 * Save response output to database
 * @param {import('express').Request} req
 * @param {string} conversationId
 * @param {string} responseId
 * @param {import('@librechat/api').Response} response
 * @param {string} agentId
 * @returns {Promise<void>}
 */
async function saveResponseOutput(req, conversationId, responseId, response, agentId) {
  // Extract text content from output items
  let responseText = '';
  for (const item of response.output) {
    if (item.type === 'message' && item.content) {
      for (const part of item.content) {
        if (part.type === 'output_text' && part.text) {
          responseText += part.text;
        }
      }
    }
  }

  // Save the assistant message
  const saveContext = createSaveMessageContext(req);
  await db.saveMessage(
    saveContext,
    {
      messageId: responseId,
      conversationId,
      parentMessageId: null,
      isCreatedByUser: false,
      text: responseText,
      sender: 'Agent',
      endpoint: EModelEndpoint.agents,
      model: agentId,
      finish_reason: response.status === 'completed' ? 'stop' : response.status,
      tokenCount: response.usage?.output_tokens,
      metadata: {
        [RESPONSE_SNAPSHOT_METADATA_KEY]: response,
      },
    },
    { context: 'Responses API - save assistant response' },
  );
}

/**
 * Save or update conversation
 * @param {import('express').Request} req
 * @param {string} conversationId
 * @param {string} agentId
 * @param {object} agent
 * @returns {Promise<void>}
 */
async function saveConversation(req, conversationId, agentId, agent) {
  await db.saveConvo(
    {
      userId: req?.user?.id,
      isTemporary: req?.body?.isTemporary,
      interfaceConfig: req?.config?.interfaceConfig,
    },
    {
      conversationId,
      endpoint: EModelEndpoint.agents,
      agentId,
      title: agent?.name || 'Open Responses Conversation',
      model: agent?.model,
    },
    { context: 'Responses API - save conversation' },
  );
}

/**
 * Persist the response and its input evidence before returning a stored response.
 * @param {import('express').Request} req
 * @param {string} conversationId
 * @param {Array} inputMessages
 * @param {string} agentId
 * @param {object} agent
 * @param {string} responseId
 * @param {import('@librechat/api').Response} response
 * @returns {Promise<void>}
 */
async function persistResponse(
  req,
  conversationId,
  inputMessages,
  agentId,
  agent,
  responseId,
  response,
) {
  await saveConversation(req, conversationId, agentId, agent);
  await saveInputMessages(req, conversationId, inputMessages, agentId);
  await saveResponseOutput(req, conversationId, responseId, response, agentId);
}

/**
 * Create Response - POST /v1/responses
 *
 * Creates a model response following the Open Responses API specification.
 * Supports both streaming and non-streaming responses.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
const createResponse = async (req, res) => {
  const appConfig = req.config;
  const requestStartTime = Date.now();

  // Validate request
  const validation = validateResponseRequest(req.body);
  if (isValidationFailure(validation)) {
    return sendResponsesErrorResponse(res, 400, validation.error);
  }

  const request = validation.request;
  const agentId = request.model;
  const isStreaming = request.stream === true;
  const summarizationConfig = appConfig?.summarization;
  const userId = req.user?.id ?? 'api-user';
  const storeResponse = shouldStoreResponse(request);

  // Look up the agent
  const agent = await db.getAgent({ id: agentId });
  if (!agent) {
    return sendResponsesErrorResponse(
      res,
      404,
      `Agent not found: ${agentId}`,
      'not_found',
      'model_not_found',
    );
  }

  // Generate IDs
  const responseId = generateResponseId();
  const context = createResponseContext(request, responseId);

  logger.debug(
    `[Responses API] Request ${responseId} started for agent ${agentId}, stream: ${isStreaming}`,
  );

  // Set up abort controller
  const abortController = new AbortController();

  // Handle client disconnect
  req.on('close', () => {
    if (!abortController.signal.aborted) {
      abortController.abort();
      logger.debug('[Responses API] Client disconnected, aborting');
    }
  });

  try {
    let previousConversationId = null;
    if (request.previous_response_id != null) {
      if (typeof request.previous_response_id !== 'string') {
        return sendResponsesErrorResponse(
          res,
          400,
          'previous_response_id must be a string',
          'invalid_request',
        );
      }
      const previousResponseMessage = await db.getMessage({
        user: req.user?.id,
        messageId: request.previous_response_id,
      });
      if (!previousResponseMessage || previousResponseMessage.isCreatedByUser) {
        return sendResponsesErrorResponse(
          res,
          404,
          `Previous response not found: ${request.previous_response_id}`,
          'not_found',
          'response_not_found',
        );
      }
      if (!getStoredResponseSnapshot(previousResponseMessage)) {
        return sendResponsesErrorResponse(
          res,
          409,
          `Stored response ${request.previous_response_id} does not include an exact persisted snapshot; this legacy record cannot be used as previous_response_id.`,
          'invalid_state',
          'response_snapshot_unavailable',
        );
      }
      if (!previousResponseMessage.conversationId) {
        return sendResponsesErrorResponse(
          res,
          409,
          `Stored response ${request.previous_response_id} is missing conversation linkage.`,
          'invalid_state',
          'previous_response_conversation_unavailable',
        );
      }
      previousConversationId = previousResponseMessage.conversationId;
    }

    const conversationId = previousConversationId ?? uuidv4();
    const parentMessageId = null;

    // Build allowed providers set
    const allowedProviders = new Set(
      appConfig?.endpoints?.[EModelEndpoint.agents]?.allowedProviders,
    );

    // Create tool loader
    const loadTools = createToolLoader(abortController.signal);

    // Initialize the agent first to check for disableStreaming
    const endpointOption = {
      endpoint: agent.provider,
      model_parameters: agent.model_parameters ?? {},
    };

    // `filterFilesByAgentAccess` is intentionally omitted: it calls
    // `checkPermission` with `resourceType: AGENT`, but this route
    // authorizes callers through `REMOTE_AGENT` (via
    // `getRemoteAgentPermissions`), so including it would silently drop
    // owner-attached context files for any remote user who has
    // `REMOTE_AGENT_VIEWER` but not direct `AGENT_VIEW`.
    const dbMethods = {
      getConvoFiles: db.getConvoFiles,
      getFiles: db.getFiles,
      getUserKey: db.getUserKey,
      getMessages: db.getMessages,
      updateFilesUsage: db.updateFilesUsage,
      getUserKeyValues: db.getUserKeyValues,
      getUserCodeFiles: db.getUserCodeFiles,
      getToolFilesByIds: db.getToolFilesByIds,
      getCodeGeneratedFiles: db.getCodeGeneratedFiles,
      listSkillsByAccess: db.listSkillsByAccess,
      listAlwaysApplySkills: db.listAlwaysApplySkills,
      getSkillByName: db.getSkillByName,
    };

    const enabledCapabilities = new Set(
      appConfig?.endpoints?.[EModelEndpoint.agents]?.capabilities,
    );
    const skillsCapabilityEnabled = enabledCapabilities.has(AgentCapabilities.skills);
    const ephemeralSkillsToggle = req.body?.ephemeralAgent?.skills === true;
    const accessibleSkillIds = skillsCapabilityEnabled
      ? await findAccessibleResources({
          userId: req.user.id,
          role: req.user.role,
          resourceType: ResourceType.SKILL,
          requiredPermissions: PermissionBits.VIEW,
        })
      : [];

    const { skillStates, defaultActiveOnShare } = await loadSkillStates({
      userId: req.user.id,
      appConfig,
      getUserById: db.getUserById,
      accessibleSkillIds,
    });

    const manualSkills = extractManualSkills(req.body);

    const primaryConfig = await initializeAgent(
      {
        req,
        res,
        loadTools,
        requestFiles: [],
        conversationId,
        parentMessageId,
        agent,
        endpointOption,
        allowedProviders,
        isInitialAgent: true,
        accessibleSkillIds: resolveAgentScopedSkillIds({
          agent,
          accessibleSkillIds,
          skillsCapabilityEnabled,
          ephemeralSkillsToggle,
        }),
        codeEnvAvailable: enabledCapabilities.has(AgentCapabilities.execute_code),
        skillStates,
        defaultActiveOnShare,
        manualSkills,
      },
      dbMethods,
    );

    /**
     * Per-agent tool-execution context map, keyed by agentId. Ensures the
     * ON_TOOL_EXECUTE callback routes each sub-agent's tool calls to the
     * correct toolRegistry / userMCPAuthMap / tool_resources.
     * @type {Map<string, {
     *   agent: object,
     *   toolRegistry?: import('@librechat/agents').LCToolRegistry,
     *   userMCPAuthMap?: Record<string, Record<string, string>>,
     *   tool_resources?: object,
     *   actionsEnabled?: boolean,
     * }>}
     */
    const agentToolContexts = new Map();
    agentToolContexts.set(primaryConfig.id, {
      agent,
      toolRegistry: primaryConfig.toolRegistry,
      userMCPAuthMap: primaryConfig.userMCPAuthMap,
      tool_resources: primaryConfig.tool_resources,
      actionsEnabled: primaryConfig.actionsEnabled,
      codeEnvAvailable: primaryConfig.codeEnvAvailable,
    });

    // Only run BFS discovery (and pay `getModelsConfig` upfront) when the
    // primary has edges to follow — the common API case is single-agent.
    let handoffAgentConfigs = new Map();
    let discoveredEdges = [];
    let discoveredMCPAuthMap;
    if (primaryConfig.edges?.length) {
      const modelsConfig = await getModelsConfig(req);
      ({
        agentConfigs: handoffAgentConfigs,
        edges: discoveredEdges,
        userMCPAuthMap: discoveredMCPAuthMap,
      } = await discoverConnectedAgents(
        {
          req,
          res,
          primaryConfig,
          endpointOption,
          allowedProviders,
          modelsConfig,
          loadTools,
          requestFiles: [],
          conversationId,
          parentMessageId,
          // The route enforces REMOTE_AGENT on the primary; every discovered
          // sub-agent must clear the same sharing boundary, not the looser
          // in-app AGENT one.
          resourceType: ResourceType.REMOTE_AGENT,
          /** @see DiscoverConnectedAgentsParams.codeEnvAvailable */
          codeEnvAvailable: enabledCapabilities.has(AgentCapabilities.execute_code),
        },
        {
          getAgent: db.getAgent,
          // Use `getRemoteAgentPermissions` so sub-agent authorization
          // matches what the route's `createCheckRemoteAgentAccess`
          // middleware does for the primary: AGENT owners with the SHARE
          // bit are treated as remotely authorized even without an
          // explicit REMOTE_AGENT grant.
          checkPermission: async ({ userId, role, resourceId, requiredPermission }) => {
            const permissions = await getRemoteAgentPermissions(
              { getEffectivePermissions },
              userId,
              role,
              resourceId,
            );
            return hasPermissions(permissions, requiredPermission);
          },
          logViolation,
          db: dbMethods,
          onAgentInitialized: (agentId, handoffAgent, config) => {
            agentToolContexts.set(agentId, {
              agent: handoffAgent,
              toolRegistry: config.toolRegistry,
              userMCPAuthMap: config.userMCPAuthMap,
              tool_resources: config.tool_resources,
              actionsEnabled: config.actionsEnabled,
              codeEnvAvailable: config.codeEnvAvailable,
            });
          },
          initializeAgent,
        },
      ));
    }

    primaryConfig.edges = discoveredEdges;
    const runAgents = [primaryConfig, ...handoffAgentConfigs.values()];
    const mergedMCPAuthMap = discoveredMCPAuthMap ?? primaryConfig.userMCPAuthMap;

    // Determine if streaming is enabled (check both request and agent config)
    const streamingDisabled = !!primaryConfig.model_parameters?.disableStreaming;
    const actuallyStreaming = isStreaming && !streamingDisabled;

    // Load previous messages if previous_response_id is provided
    let previousMessages = [];
    if (previousConversationId) {
      previousMessages = await loadPreviousMessages(previousConversationId, userId);
    }

    // Convert input to internal messages
    const inputMessages = convertToInternalMessages(
      typeof request.input === 'string' ? request.input : request.input,
    );

    // Merge previous messages with new input
    const allMessages = [...previousMessages, ...inputMessages];

    const toolSet = buildToolSet(primaryConfig);
    const formatted = formatAgentMessages(allMessages, {}, toolSet);
    const formattedMessages = formatted.messages;
    const initialSummary = formatted.summary;
    let indexTokenCountMap = formatted.indexTokenCountMap;

    /**
     * Inject manual + always-apply skill primes so the model sees SKILL.md
     * bodies for this turn — parity with AgentClient's chat path. The
     * Responses API uses its own response-builder shape, so LibreChat-
     * style card SSE events don't apply; only the message-context part
     * carries over.
     */
    const manualSkillPrimes = primaryConfig.manualSkillPrimes;
    const alwaysApplySkillPrimes = primaryConfig.alwaysApplySkillPrimes;
    if (
      (manualSkillPrimes && manualSkillPrimes.length > 0) ||
      (alwaysApplySkillPrimes && alwaysApplySkillPrimes.length > 0)
    ) {
      const primeResult = injectSkillPrimes({
        initialMessages: formattedMessages,
        indexTokenCountMap,
        manualSkillPrimes,
        alwaysApplySkillPrimes,
      });
      indexTokenCountMap = primeResult.indexTokenCountMap;
      /* Surface the cap-driven always-apply truncation at the controller
         layer too — `injectSkillPrimes` already logs internally, but the
         controller-level warn includes endpoint context so operators can
         tell at a glance which path hit the cap. Mirrors AgentClient's
         warn in `client.js`. */
      if (primeResult.alwaysApplyDropped > 0) {
        logger.warn(
          `[Responses API] Dropped ${primeResult.alwaysApplyDropped} always-apply prime(s) to stay within MAX_PRIMED_SKILLS_PER_TURN.`,
        );
      }
    }

    /* Stable for the turn: the prime lists are fixed once
       `initializeAgent` resolves. Hoisted here so both the streaming
       and non-streaming `loadTools` closures below reuse it without
       recomputing per tool execution. `codeEnvAvailable` is read
       per-agent from the stored tool context (admin cap AND that
       agent's `tools` list includes `execute_code`) — a skills-only
       agent never gains sandbox access even if the admin enabled the
       capability globally. */
    const skillPrimedIdsByName = buildSkillPrimedIdsByName(
      manualSkillPrimes,
      alwaysApplySkillPrimes,
    );

    // Create tracker for streaming or aggregator for non-streaming
    const tracker = actuallyStreaming ? createResponseTracker() : null;
    const aggregator = actuallyStreaming ? null : createResponseAggregator();

    // Set up response for streaming
    if (actuallyStreaming) {
      setupStreamingResponse(res);

      // Create handler config
      const handlerConfig = {
        res,
        context,
        tracker,
      };

      // Emit response.created then response.in_progress per Open Responses spec
      emitResponseCreated(handlerConfig);
      emitResponseInProgress(handlerConfig);

      // Create event handlers
      const {
        handlers: responsesHandlers,
        closeOpenStreams,
        finalizeStream,
      } = createResponsesEventHandlers(handlerConfig);

      // Collect usage for balance tracking
      const collectedUsage = [];

      // Artifact promises for processing tool outputs
      /** @type {Promise<import('librechat-data-provider').TAttachment | null>[]} */
      const artifactPromises = [];
      // Use Responses API-specific callback that emits librechat:attachment events
      const toolEndCallback = createResponsesToolEndCallback({
        req,
        res,
        tracker,
        artifactPromises,
      });

      // Create tool execute options for event-driven tool execution
      const toolExecuteOptions = {
        loadTools: async (toolNames, agentId) => {
          const ctx =
            agentToolContexts.get(agentId) ?? agentToolContexts.get(primaryConfig.id) ?? {};
          const result = await loadToolsForExecution({
            req,
            res,
            toolNames,
            agent: ctx.agent ?? agent,
            signal: abortController.signal,
            toolRegistry: ctx.toolRegistry,
            userMCPAuthMap: ctx.userMCPAuthMap,
            tool_resources: ctx.tool_resources,
            actionsEnabled: ctx.actionsEnabled,
          });
          return enrichWithSkillConfigurable(
            result,
            req,
            primaryConfig.accessibleSkillIds,
            ctx.codeEnvAvailable === true,
            skillPrimedIdsByName,
          );
        },
        toolEndCallback,
        ...getSkillToolDeps(),
      };

      // Combine handlers
      const handlers = {
        on_message_delta: responsesHandlers.on_message_delta,
        on_reasoning_delta: responsesHandlers.on_reasoning_delta,
        on_run_step: responsesHandlers.on_run_step,
        on_run_step_delta: responsesHandlers.on_run_step_delta,
        on_chat_model_end: {
          handle: (event, data, metadata) => {
            responsesHandlers.on_chat_model_end.handle(event, data);
            const usage = data?.output?.usage_metadata;
            if (usage) {
              const taggedUsage = markSummarizationUsage(usage, metadata);
              collectedUsage.push(taggedUsage);
            }
          },
        },
        on_tool_end: new ToolEndHandler(toolEndCallback, logger),
        on_run_step_completed: { handle: () => {} },
        on_chain_stream: { handle: () => {} },
        on_chain_end: { handle: () => {} },
        on_agent_update: { handle: () => {} },
        on_custom_event: { handle: () => {} },
        on_tool_execute: createToolExecuteHandler(toolExecuteOptions),
        on_agent_log: agentLogHandlerObj,
        ...(summarizationConfig?.enabled !== false
          ? buildSummarizationHandlers({ isStreaming: actuallyStreaming, res })
          : {}),
      };

      // Create and run the agent
      const userMCPAuthMap = mergedMCPAuthMap;

      const run = await createRun({
        agents: runAgents,
        messages: formattedMessages,
        indexTokenCountMap,
        initialSummary,
        runId: responseId,
        summarizationConfig,
        appConfig,
        signal: abortController.signal,
        customHandlers: handlers,
        requestBody: {
          messageId: responseId,
          conversationId,
        },
        user: { id: userId },
      });

      if (!run) {
        throw new Error('Failed to create agent run');
      }

      // Process the stream
      const config = {
        runName: 'AgentRun',
        configurable: {
          thread_id: conversationId,
          user_id: userId,
          user: createSafeUser(req.user),
          requestBody: {
            messageId: responseId,
            conversationId,
          },
          ...(userMCPAuthMap != null && { userMCPAuthMap }),
        },
        signal: abortController.signal,
        streamMode: 'values',
        version: 'v2',
      };

      await run.processStream({ messages: formattedMessages }, config, {
        callbacks: {
          [Callback.TOOL_ERROR]: (graph, error, toolId) => {
            logger.error(`[Responses API] Tool Error "${toolId}"`, error);
          },
        },
      });

      // Record token usage against balance
      const balanceConfig = getBalanceConfig(appConfig);
      const transactionsConfig = getTransactionsConfig(appConfig);
      recordCollectedUsage(
        {
          spendTokens: db.spendTokens,
          spendStructuredTokens: db.spendStructuredTokens,
          pricing: { getMultiplier: db.getMultiplier, getCacheMultiplier: db.getCacheMultiplier },
          bulkWriteOps: { insertMany: db.bulkInsertTransactions, updateBalance: db.updateBalance },
        },
        {
          user: userId,
          conversationId,
          collectedUsage,
          context: 'message',
          messageId: responseId,
          balance: balanceConfig,
          transactions: transactionsConfig,
          model: primaryConfig.model || agent.model_parameters?.model,
        },
      ).catch((err) => {
        logger.error('[Responses API] Error recording usage:', err);
      });

      if (storeResponse) {
        closeOpenStreams();
        const finalResponse = buildResponse(context, tracker, 'completed');
        try {
          await persistResponse(
            req,
            conversationId,
            inputMessages,
            agentId,
            agent,
            responseId,
            finalResponse,
          );
          logger.debug(
            `[Responses API] Stored response ${responseId} in conversation ${conversationId}`,
          );
        } catch (saveError) {
          logger.error('[Responses API] Error saving response:', saveError);
          emitResponseFailed(handlerConfig, {
            type: 'server_error',
            message: 'Failed to store response before completion',
            code: 'response_storage_failed',
          });
          writeDone(res);
          res.end();
          return;
        }

        emitResponseCompleted(handlerConfig);
        writeDone(res);
      } else {
        finalizeStream();
      }

      res.end();

      const duration = Date.now() - requestStartTime;
      logger.debug(`[Responses API] Request ${responseId} completed in ${duration}ms (streaming)`);

      // Wait for artifact processing after response ends (non-blocking)
      if (artifactPromises.length > 0) {
        Promise.all(artifactPromises).catch((artifactError) => {
          logger.warn('[Responses API] Error processing artifacts:', artifactError);
        });
      }
    } else {
      const aggregatorHandlers = createAggregatorEventHandlers(aggregator);

      // Collect usage for balance tracking
      const collectedUsage = [];

      /** @type {Promise<import('librechat-data-provider').TAttachment | null>[]} */
      const artifactPromises = [];
      const toolEndCallback = createToolEndCallback({ req, res, artifactPromises, streamId: null });

      const toolExecuteOptions = {
        loadTools: async (toolNames, agentId) => {
          const ctx =
            agentToolContexts.get(agentId) ?? agentToolContexts.get(primaryConfig.id) ?? {};
          const result = await loadToolsForExecution({
            req,
            res,
            toolNames,
            agent: ctx.agent ?? agent,
            signal: abortController.signal,
            toolRegistry: ctx.toolRegistry,
            userMCPAuthMap: ctx.userMCPAuthMap,
            tool_resources: ctx.tool_resources,
            actionsEnabled: ctx.actionsEnabled,
          });
          return enrichWithSkillConfigurable(
            result,
            req,
            primaryConfig.accessibleSkillIds,
            ctx.codeEnvAvailable === true,
            skillPrimedIdsByName,
          );
        },
        toolEndCallback,
        ...getSkillToolDeps(),
      };

      const handlers = {
        on_message_delta: aggregatorHandlers.on_message_delta,
        on_reasoning_delta: aggregatorHandlers.on_reasoning_delta,
        on_run_step: aggregatorHandlers.on_run_step,
        on_run_step_delta: aggregatorHandlers.on_run_step_delta,
        on_chat_model_end: {
          handle: (event, data, metadata) => {
            aggregatorHandlers.on_chat_model_end.handle(event, data);
            const usage = data?.output?.usage_metadata;
            if (usage) {
              const taggedUsage = markSummarizationUsage(usage, metadata);
              collectedUsage.push(taggedUsage);
            }
          },
        },
        on_tool_end: new ToolEndHandler(toolEndCallback, logger),
        on_run_step_completed: { handle: () => {} },
        on_chain_stream: { handle: () => {} },
        on_chain_end: { handle: () => {} },
        on_agent_update: { handle: () => {} },
        on_custom_event: { handle: () => {} },
        on_tool_execute: createToolExecuteHandler(toolExecuteOptions),
        on_agent_log: agentLogHandlerObj,
        ...(summarizationConfig?.enabled !== false
          ? buildSummarizationHandlers({ isStreaming: false, res })
          : {}),
      };

      const userMCPAuthMap = mergedMCPAuthMap;

      const run = await createRun({
        agents: runAgents,
        messages: formattedMessages,
        indexTokenCountMap,
        initialSummary,
        runId: responseId,
        summarizationConfig,
        appConfig,
        signal: abortController.signal,
        customHandlers: handlers,
        requestBody: {
          messageId: responseId,
          conversationId,
        },
        user: { id: userId },
      });

      if (!run) {
        throw new Error('Failed to create agent run');
      }

      const config = {
        runName: 'AgentRun',
        configurable: {
          thread_id: conversationId,
          user_id: userId,
          user: createSafeUser(req.user),
          requestBody: {
            messageId: responseId,
            conversationId,
          },
          ...(userMCPAuthMap != null && { userMCPAuthMap }),
        },
        signal: abortController.signal,
        streamMode: 'values',
        version: 'v2',
      };

      await run.processStream({ messages: formattedMessages }, config, {
        callbacks: {
          [Callback.TOOL_ERROR]: (graph, error, toolId) => {
            logger.error(`[Responses API] Tool Error "${toolId}"`, error);
          },
        },
      });

      // Record token usage against balance
      const balanceConfig = getBalanceConfig(appConfig);
      const transactionsConfig = getTransactionsConfig(appConfig);
      recordCollectedUsage(
        {
          spendTokens: db.spendTokens,
          spendStructuredTokens: db.spendStructuredTokens,
          pricing: { getMultiplier: db.getMultiplier, getCacheMultiplier: db.getCacheMultiplier },
          bulkWriteOps: { insertMany: db.bulkInsertTransactions, updateBalance: db.updateBalance },
        },
        {
          user: userId,
          conversationId,
          collectedUsage,
          context: 'message',
          messageId: responseId,
          balance: balanceConfig,
          transactions: transactionsConfig,
          model: primaryConfig.model || agent.model_parameters?.model,
        },
      ).catch((err) => {
        logger.error('[Responses API] Error recording usage:', err);
      });

      if (artifactPromises.length > 0) {
        try {
          await Promise.all(artifactPromises);
        } catch (artifactError) {
          logger.warn('[Responses API] Error processing artifacts:', artifactError);
        }
      }

      const response = buildAggregatedResponse(context, aggregator);

      if (storeResponse) {
        try {
          await persistResponse(
            req,
            conversationId,
            inputMessages,
            agentId,
            agent,
            responseId,
            response,
          );
          logger.debug(
            `[Responses API] Stored response ${responseId} in conversation ${conversationId}`,
          );
        } catch (saveError) {
          logger.error('[Responses API] Error saving response:', saveError);
          return sendResponsesErrorResponse(
            res,
            500,
            'Failed to store response before completion',
            'server_error',
            'response_storage_failed',
          );
        }
      }

      res.json(response);

      const duration = Date.now() - requestStartTime;
      logger.debug(
        `[Responses API] Request ${responseId} completed in ${duration}ms (non-streaming)`,
      );
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'An error occurred';
    logger.error('[Responses API] Error:', error);

    // Check if we already started streaming (headers sent)
    if (res.headersSent) {
      // Headers already sent, write error event and close
      writeDone(res);
      res.end();
    } else {
      // Forward upstream provider status codes (e.g., Anthropic 400s) instead of masking as 500
      const statusCode =
        typeof error?.status === 'number' && error.status >= 400 && error.status < 600
          ? error.status
          : 500;
      const errorType = statusCode >= 400 && statusCode < 500 ? 'invalid_request' : 'server_error';
      sendResponsesErrorResponse(res, statusCode, errorMessage, errorType);
    }
  }
};

/**
 * List available agents as models - GET /v1/models (also works with /v1/responses/models)
 *
 * Returns a list of available agents the user has remote access to.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
const listModels = async (req, res) => {
  try {
    const userId = req.user?.id;
    const userRole = req.user?.role;

    if (!userId) {
      return sendResponsesErrorResponse(res, 401, 'Authentication required', 'auth_error');
    }

    // Find agents the user has remote access to (VIEW permission on REMOTE_AGENT)
    const accessibleAgentIds = await findAccessibleResources({
      userId,
      role: userRole,
      resourceType: ResourceType.REMOTE_AGENT,
      requiredPermissions: PermissionBits.VIEW,
    });

    // Get the accessible agents
    let agents = [];
    if (accessibleAgentIds.length > 0) {
      agents = await db.getAgents({ _id: { $in: accessibleAgentIds } });
    }

    // Convert to models format
    const models = agents.map((agent) => ({
      id: agent.id,
      object: 'model',
      created: Math.floor(new Date(agent.createdAt).getTime() / 1000),
      owned_by: agent.author ?? 'librechat',
      // Additional metadata
      name: agent.name,
      description: agent.description,
      provider: agent.provider,
    }));

    res.json({
      object: 'list',
      data: models,
    });
  } catch (error) {
    logger.error('[Responses API] Error listing models:', error);
    sendResponsesErrorResponse(
      res,
      500,
      error instanceof Error ? error.message : 'Failed to list models',
      'server_error',
    );
  }
};

/**
 * Get Response - GET /v1/responses/:id
 *
 * Retrieves a stored response by its ID.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
const getResponse = async (req, res) => {
  try {
    const responseId = req.params.id;
    const userId = req.user?.id;

    if (!responseId) {
      return sendResponsesErrorResponse(res, 400, 'Response ID is required');
    }

    const responseMessage = await db.getMessage({ user: userId, messageId: responseId });
    if (!responseMessage) {
      return sendResponsesErrorResponse(
        res,
        404,
        `Response not found: ${responseId}`,
        'not_found',
        'response_not_found',
      );
    }

    const storedSnapshot = getStoredResponseSnapshot(responseMessage);
    if (!storedSnapshot) {
      return sendResponsesErrorResponse(
        res,
        409,
        `Stored response ${responseId} does not include an exact persisted snapshot; this legacy record cannot be returned truthfully.`,
        'invalid_state',
        'response_snapshot_unavailable',
      );
    }

    res.json(storedSnapshot);
  } catch (error) {
    logger.error('[Responses API] Error getting response:', error);
    sendResponsesErrorResponse(
      res,
      500,
      error instanceof Error ? error.message : 'Failed to get response',
      'server_error',
    );
  }
};

module.exports = {
  createResponse,
  getResponse,
  listModels,
};
