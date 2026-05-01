const express = require('express');
const {
  isEnabled,
  sendEvent,
  isCanonicalResumeState,
  isReplayEvent,
  createSyncEvent,
  createFinalErrorEvent,
  GenerationJobManager,
} = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const {
  uaParser,
  checkBan,
  requireJwtAuth,
  messageIpLimiter,
  configMiddleware,
  messageUserLimiter,
} = require('~/server/middleware');
const { saveMessage } = require('~/models');
const responses = require('./responses');
const openai = require('./openai');
const { v1 } = require('./v1');
const chat = require('./chat');

const { LIMIT_MESSAGE_IP, LIMIT_MESSAGE_USER } = process.env ?? {};
const RESUME_SYNC_UNAVAILABLE_MESSAGE =
  'Unable to resume stream: canonical sync state unavailable.';
const RESUME_SYNC_UNAVAILABLE_CODE = 'canonical_resume_state_unavailable';

/** Untenanted jobs (pre-multi-tenancy) remain accessible if the userId check passes. */
function hasTenantMismatch(job, user) {
  return job.metadata?.tenantId != null && job.metadata.tenantId !== user.tenantId;
}

const router = express.Router();

/**
 * Open Responses API routes (API key authentication handled in route file)
 * Mounted at /agents/v1/responses (full path: /api/agents/v1/responses)
 * NOTE: Must be mounted BEFORE /v1 to avoid being caught by the less specific route
 * @see https://openresponses.org/specification
 */
router.use('/v1/responses', responses);

/**
 * OpenAI-compatible API routes (API key authentication handled in route file)
 * Mounted at /agents/v1 (full path: /api/agents/v1/chat/completions)
 */
router.use('/v1', openai);

router.use(requireJwtAuth);
router.use(checkBan);

/**
 * Stream endpoints - mounted before chatRouter to bypass rate limiters
 * These are GET requests and don't need message body validation or rate limiting
 */

/**
 * @route GET /chat/stream/:streamId
 * @desc Subscribe to an ongoing generation job's SSE stream with replay support
 * @access Private
 * @description Sends one canonical sync payload on reconnect or fails in-band on the message channel
 * @query resume=true - Indicates this is a reconnection (sends a sync event when canonical state exists)
 */
router.get('/chat/stream/:streamId', async (req, res) => {
  const { streamId } = req.params;
  const isResume = req.query.resume === 'true';

  const job = await GenerationJobManager.getJob(streamId);
  if (!job) {
    return res.status(404).json({
      error: 'Stream not found',
      message: 'The generation job does not exist or has expired.',
    });
  }

  if (job.metadata?.userId && job.metadata.userId !== req.user.id) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  if (hasTenantMismatch(job, req.user)) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  res.setHeader('Content-Encoding', 'identity');
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  logger.debug(`[AgentStream] Client subscribed to ${streamId}, resume: ${isResume}`);

  const writeEvent = (event) => {
    if (!res.writableEnded) {
      sendEvent(res, event);
      if (typeof res.flush === 'function') {
        res.flush();
      }
    }
  };

  const onDone = (event) => {
    writeEvent(event);
    res.end();
  };

  const onError = (message, code) => {
    if (res.writableEnded) {
      return;
    }

    const errorEvent =
      code != null ? createFinalErrorEvent(message, code) : createFinalErrorEvent(message);
    writeEvent(errorEvent);
    res.end();
  };

  let result;

  if (isResume) {
    const bufferedEvents = [];
    let bufferedTerminal = null;
    const gatedWriteEvent = (event) => {
      bufferedEvents.push(event);
    };
    const gatedOnDone = (event) => {
      bufferedTerminal = { type: 'done', event };
    };
    const gatedOnError = (message) => {
      bufferedTerminal = { type: 'error', message };
    };
    const {
      subscription,
      resumeState: rawResumeState,
      pendingEvents,
    } = await GenerationJobManager.subscribeWithResume(
      streamId,
      gatedWriteEvent,
      gatedOnDone,
      gatedOnError,
    );
    const resumeState = isCanonicalResumeState(rawResumeState) ? rawResumeState : null;
    const replayEvents =
      Array.isArray(pendingEvents) && pendingEvents.every(isReplayEvent) ? pendingEvents : null;

    if (rawResumeState != null && !resumeState) {
      logger.warn(`[AgentStream] Resume state missing canonical IDs for ${streamId}`);
    }
    if (Array.isArray(pendingEvents) && replayEvents == null) {
      logger.warn(
        `[AgentStream] Pending replay events fell outside the canonical contract for ${streamId}`,
      );
    }

    if (!res.writableEnded) {
      if (resumeState && replayEvents) {
        const syncEvent = createSyncEvent({
          resumeState,
          pendingEvents: replayEvents,
        });
        writeEvent(syncEvent);
        GenerationJobManager.markSyncSent(streamId);
        logger.debug(
          `[AgentStream] Sent sync event for ${streamId} with ${resumeState.runSteps.length} run steps, ${replayEvents.length} pending events`,
        );
        for (const event of bufferedEvents) {
          writeEvent(event);
        }
        if (bufferedTerminal?.type === 'done') {
          onDone(bufferedTerminal.event);
        } else if (bufferedTerminal?.type === 'error') {
          onError(bufferedTerminal.message);
        }
      } else {
        const isCanonicalResumeFailure = bufferedTerminal?.type !== 'error';
        const resumeFailureMessage = !isCanonicalResumeFailure
          ? bufferedTerminal.message
          : RESUME_SYNC_UNAVAILABLE_MESSAGE;
        logger.warn(
          `[AgentStream] Missing canonical resume state for ${streamId}; sent in-band final error instead of replay fallback`,
        );
        if (isCanonicalResumeFailure) {
          onError(resumeFailureMessage, RESUME_SYNC_UNAVAILABLE_CODE);
        } else {
          onError(resumeFailureMessage);
        }
      }
    }

    result = subscription;
  } else {
    result = await GenerationJobManager.subscribe(streamId, writeEvent, onDone, onError);
  }

  if (!result) {
    if (res.writableEnded) {
      return;
    }
    return res.status(404).json({ error: 'Failed to subscribe to stream' });
  }

  if (res.writableEnded) {
    result.unsubscribe();
    return;
  }

  req.on('close', () => {
    logger.debug(`[AgentStream] Client disconnected from ${streamId}`);
    result.unsubscribe();
  });
});

/**
 * @route GET /chat/active
 * @desc Get all active generation job IDs for the current user
 * @access Private
 * @returns { activeJobIds: string[] }
 */
router.get('/chat/active', async (req, res) => {
  const activeJobIds = await GenerationJobManager.getActiveJobIdsForUser(
    req.user.id,
    req.user.tenantId,
  );
  res.json({ activeJobIds });
});

/**
 * @route GET /chat/status/:conversationId
 * @desc Check if there's an active generation job for a conversation
 * @access Private
 * @returns { active, streamId, status, aggregatedContent, createdAt, resumeState }
 */
router.get('/chat/status/:conversationId', async (req, res) => {
  const { conversationId } = req.params;

  // streamId === conversationId, so we can use getJob directly
  const job = await GenerationJobManager.getJob(conversationId);

  if (!job) {
    return res.json({ active: false });
  }

  if (job.metadata.userId !== req.user.id) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  if (hasTenantMismatch(job, req.user)) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  // Get resume state which contains aggregatedContent
  // Avoid calling both getStreamInfo and getResumeState (both fetch content)
  const rawResumeState = await GenerationJobManager.getResumeState(conversationId);
  const resumeState = isCanonicalResumeState(rawResumeState) ? rawResumeState : null;
  if (rawResumeState != null && !resumeState) {
    logger.warn(`[AgentStream] Resume state missing canonical IDs for ${conversationId}`);
  }
  const resumeError =
    resumeState == null
      ? {
          code: RESUME_SYNC_UNAVAILABLE_CODE,
          message: RESUME_SYNC_UNAVAILABLE_MESSAGE,
        }
      : null;
  const isActive = job.status === 'running';

  res.json({
    active: isActive,
    streamId: conversationId,
    status: job.status,
    aggregatedContent: resumeState?.aggregatedContent ?? [],
    createdAt: job.createdAt,
    resumeState,
    resumeStateStatus: resumeState == null ? 'unavailable' : 'available',
    resumeError,
  });
});

/**
 * @route POST /chat/abort
 * @desc Abort an ongoing generation job
 * @access Private
 * @description Mounted before chatRouter to bypass buildEndpointOption middleware
 */
router.post('/chat/abort', async (req, res) => {
  logger.debug(`[AgentStream] ========== ABORT ENDPOINT HIT ==========`);
  logger.debug(`[AgentStream] Method: ${req.method}, Path: ${req.path}`);
  logger.debug(`[AgentStream] Body:`, req.body);

  const { streamId, conversationId, abortKey } = req.body;
  const userId = req.user?.id;

  // streamId === conversationId, so try any of the provided IDs
  // Skip "new" as it's a placeholder for new conversations, not an actual ID
  let jobStreamId =
    streamId || (conversationId !== 'new' ? conversationId : null) || abortKey?.split(':')[0];
  let job = jobStreamId ? await GenerationJobManager.getJob(jobStreamId) : null;

  // Fallback: if job not found and we have a userId, look up active jobs for user
  // This handles the case where frontend sends "new" but job was created with a UUID
  if (!job && userId) {
    logger.debug(`[AgentStream] Job not found by ID, checking active jobs for user: ${userId}`);
    const activeJobIds = await GenerationJobManager.getActiveJobIdsForUser(
      userId,
      req.user.tenantId,
    );
    if (activeJobIds.length > 0) {
      // Abort the most recent active job for this user
      jobStreamId = activeJobIds[0];
      job = await GenerationJobManager.getJob(jobStreamId);
      logger.debug(`[AgentStream] Found active job for user: ${jobStreamId}`);
    }
  }

  logger.debug(`[AgentStream] Computed jobStreamId: ${jobStreamId}`);

  if (job && jobStreamId) {
    if (job.metadata?.userId && job.metadata.userId !== userId) {
      logger.warn(`[AgentStream] Unauthorized abort attempt for ${jobStreamId} by user ${userId}`);
      return res.status(403).json({ error: 'Unauthorized' });
    }

    if (hasTenantMismatch(job, req.user)) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    logger.debug(`[AgentStream] Job found, aborting: ${jobStreamId}`);
    const abortResult = await GenerationJobManager.abortJob(jobStreamId);
    logger.debug(`[AgentStream] Job aborted successfully: ${jobStreamId}`, {
      abortResultSuccess: abortResult.success,
      abortResultUserMessageId: abortResult.jobData?.userMessage?.messageId,
      abortResultResponseMessageId: abortResult.jobData?.responseMessageId,
    });

    // CRITICAL: Save partial response BEFORE returning to prevent race condition.
    // If user sends a follow-up immediately after abort, the parentMessageId must exist in DB.
    // Only save if we have a valid responseMessageId (skip early aborts before generation started)
    if (
      abortResult.success &&
      abortResult.jobData?.userMessage?.messageId &&
      abortResult.jobData?.responseMessageId
    ) {
      const { jobData, content, text } = abortResult;
      const responseMessage = {
        messageId: jobData.responseMessageId,
        parentMessageId: jobData.userMessage.messageId,
        conversationId: jobData.conversationId,
        content: content || [],
        text: text || '',
        sender: jobData.sender || 'AI',
        endpoint: jobData.endpoint,
        model: jobData.model,
        unfinished: true,
        error: false,
        isCreatedByUser: false,
        user: userId,
      };

      try {
        await saveMessage(
          {
            userId: req?.user?.id,
            isTemporary: req?.body?.isTemporary,
            interfaceConfig: req?.config?.interfaceConfig,
          },
          responseMessage,
          { context: 'api/server/routes/agents/index.js - abort endpoint' },
        );
        logger.debug(`[AgentStream] Saved partial response for: ${jobStreamId}`);
      } catch (saveError) {
        logger.error(`[AgentStream] Failed to save partial response: ${saveError.message}`);
      }
    }

    return res.json({ success: true, aborted: jobStreamId });
  }

  logger.warn(`[AgentStream] Job not found for streamId: ${jobStreamId}`);
  return res.status(404).json({ error: 'Job not found', streamId: jobStreamId });
});

router.use(uaParser);
router.use('/', v1);

const chatRouter = express.Router();
chatRouter.use(configMiddleware);

if (isEnabled(LIMIT_MESSAGE_IP)) {
  chatRouter.use(messageIpLimiter);
}

if (isEnabled(LIMIT_MESSAGE_USER)) {
  chatRouter.use(messageUserLimiter);
}

chatRouter.use('/', chat);
router.use('/chat', chatRouter);

module.exports = router;
