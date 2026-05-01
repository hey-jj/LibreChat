import { useEffect, useState, useRef, useCallback } from 'react';
import { v4 } from 'uuid';
import { SSE } from 'sse.js';
import { useSetRecoilState } from 'recoil';
import { useQueryClient } from '@tanstack/react-query';
import {
  request,
  Constants,
  ContentTypes,
  QueryKeys,
  StepEvents,
  apiBaseUrl,
  createPayload,
  removeNullishValues,
} from 'librechat-data-provider';
import type {
  Agents,
  TAttachment,
  TContentData,
  TConversation,
  TMessage,
  TMessageContentParts,
  TPayload,
  TSubmission,
  EventSubmission,
} from 'librechat-data-provider';
import type { EventHandlerParams } from './useEventHandlers';
import {
  isLegacyAgentAttachmentEvent,
  isLegacyAgentContentEvent,
  isLegacyAgentCreatedEvent,
  isLegacyAgentFinalEvent,
  isLegacyAgentStreamEvent,
  isLegacyAgentSyncEvent,
} from './legacyAgentStream';
import type { LegacyCreatedEvent, LegacyFinalEvent } from './legacyAgentStream';
import {
  useGetUserBalance,
  useGetStartupConfig,
  queueTitleGeneration,
  streamStatusQueryKey,
} from '~/data-provider';
import type { ActiveJobsResponse } from '~/data-provider';
import { useAuthContext } from '~/hooks/AuthContext';
import useEventHandlers from './useEventHandlers';
import { clearAllDrafts } from '~/utils';
import store from '~/store';

export type ChatHelpers = Pick<
  EventHandlerParams,
  | 'setMessages'
  | 'getMessages'
  | 'setConversation'
  | 'setIsSubmitting'
  | 'newConversation'
  | 'resetLatestMessage'
>;

const MAX_RETRIES = 5;

function getStreamText(data: TContentData): string | undefined {
  if (data.type !== ContentTypes.TEXT) {
    return undefined;
  }
  return typeof data.text === 'string' ? data.text : data.text?.value;
}

function normalizeAggregatedContent(
  aggregatedContent: NonNullable<Agents.ResumeState['aggregatedContent']>,
): TMessageContentParts[] {
  return aggregatedContent.map((part) => ({ ...part })) as TMessageContentParts[];
}

/**
 * Hook for resumable SSE streams.
 * Separates generation start (POST) from stream subscription (GET EventSource).
 * Supports auto-reconnection with exponential backoff.
 *
 * Key behavior:
 * - Navigation away does NOT abort the generation (just closes SSE)
 * - Only explicit abort (via stop button → backend abort endpoint) stops generation
 * - Backend emits `done` event with `aborted: true` on abort, handled via finalHandler
 */
export default function useResumableSSE(
  submission: TSubmission | null,
  chatHelpers: ChatHelpers,
  isAddedRequest = false,
  runIndex = 0,
) {
  const queryClient = useQueryClient();
  const setActiveRunId = useSetRecoilState(store.activeRunFamily(runIndex));

  const { token, isAuthenticated } = useAuthContext();

  /**
   * Optimistically add a job ID to the active jobs cache.
   * Called when generation starts.
   */
  const addActiveJob = useCallback(
    (jobId: string) => {
      queryClient.setQueryData<ActiveJobsResponse>([QueryKeys.activeJobs], (old) => ({
        activeJobIds: [...new Set([...(old?.activeJobIds ?? []), jobId])],
      }));
    },
    [queryClient],
  );

  /**
   * Optimistically remove a job ID from the active jobs cache.
   * Called when generation completes, aborts, or errors.
   */
  const removeActiveJob = useCallback(
    (jobId: string) => {
      queryClient.setQueryData<ActiveJobsResponse>([QueryKeys.activeJobs], (old) => ({
        activeJobIds: (old?.activeJobIds ?? []).filter((id) => id !== jobId),
      }));
    },
    [queryClient],
  );
  const [_completed, setCompleted] = useState(new Set());
  const [streamId, setStreamId] = useState<string | null>(null);
  const setAbortScroll = useSetRecoilState(store.abortScrollFamily(runIndex));
  const setShowStopButton = useSetRecoilState(store.showStopButtonByIndex(runIndex));

  const sseRef = useRef<SSE | null>(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const submissionRef = useRef<TSubmission | null>(null);

  const {
    setMessages,
    getMessages,
    setConversation,
    setIsSubmitting,
    newConversation,
    resetLatestMessage,
  } = chatHelpers;

  const {
    stepHandler,
    finalHandler,
    errorHandler,
    clearStepMaps,
    contentHandler,
    createdHandler,
    announceReplyStart,
    syncStepMessage,
    attachmentHandler,
    resetContentHandler,
  } = useEventHandlers({
    setMessages,
    getMessages,
    setCompleted,
    isAddedRequest,
    setConversation,
    setIsSubmitting,
    newConversation,
    setShowStopButton,
    resetLatestMessage,
  });

  const { data: startupConfig } = useGetStartupConfig();
  const balanceQuery = useGetUserBalance({
    enabled: !!isAuthenticated && startupConfig?.balance?.enabled,
  });

  /**
   * Subscribe to stream via SSE library (supports custom headers)
   * Follows same auth pattern as useSSE
   * @param isResume - If true, adds ?resume=true to trigger sync event from server
   */
  const subscribeToStream = useCallback(
    (currentStreamId: string, currentSubmission: TSubmission, isResume = false) => {
      let { userMessage } = currentSubmission;
      let textIndex: number | null = null;

      type CreatedHandlerData = Parameters<typeof createdHandler>[0];
      type FinalHandlerData = Parameters<typeof finalHandler>[0] & {
        aborted?: boolean;
        earlyAbort?: boolean;
        error?: LegacyFinalEvent['error'];
      };
      type StepHandlerEvent = Parameters<typeof stepHandler>[0];

      const toRequestMessage = (
        message: LegacyCreatedEvent['message'] | LegacyFinalEvent['requestMessage'],
      ): TMessage =>
        ({
          ...(currentSubmission.userMessage as TMessage),
          ...(message ?? {}),
        }) as TMessage;

      const toResponseMessage = (
        message: LegacyFinalEvent['responseMessage'] | null | undefined,
        parentMessageId?: string,
      ): TMessage =>
        ({
          ...(currentSubmission.initialResponse as TMessage),
          ...(message ?? {}),
          parentMessageId:
            message?.parentMessageId ??
            parentMessageId ??
            (currentSubmission.initialResponse as TMessage).parentMessageId,
          conversationId:
            message?.conversationId ??
            currentSubmission.conversation?.conversationId ??
            currentSubmission.userMessage?.conversationId,
        }) as TMessage;

      const toCreatedHandlerData = (event: LegacyCreatedEvent): CreatedHandlerData => {
        const requestMessage = toRequestMessage(event.message);
        return {
          conversation: currentSubmission.conversation as TConversation,
          requestMessage,
          responseMessage: toResponseMessage(undefined, requestMessage.messageId),
        };
      };

      const toFinalHandlerData = (event: LegacyFinalEvent): FinalHandlerData => ({
        ...event,
        conversation: {
          conversationId:
            event.conversation?.conversationId ??
            currentSubmission.conversation?.conversationId ??
            currentSubmission.userMessage?.conversationId ??
            currentStreamId,
          ...(event.conversation ?? {}),
        },
        requestMessage: event.requestMessage ? toRequestMessage(event.requestMessage) : undefined,
        responseMessage: event.responseMessage
          ? toResponseMessage(event.responseMessage)
          : undefined,
        runMessages: event.runMessages?.map((message) => toResponseMessage(message)),
      });

      const toStepHandlerEvent = (event: unknown): StepHandlerEvent | null => {
        if (!isLegacyAgentStreamEvent(event)) {
          return null;
        }

        switch (event.event) {
          case StepEvents.ON_RUN_STEP:
          case StepEvents.ON_AGENT_UPDATE:
          case StepEvents.ON_MESSAGE_DELTA:
          case StepEvents.ON_REASONING_DELTA:
          case StepEvents.ON_RUN_STEP_DELTA:
          case StepEvents.ON_RUN_STEP_COMPLETED:
          case StepEvents.ON_SUMMARIZE_START:
          case StepEvents.ON_SUMMARIZE_DELTA:
          case StepEvents.ON_SUMMARIZE_COMPLETE:
            return event as StepHandlerEvent;
          default:
            return null;
        }
      };

      const baseUrl = `${apiBaseUrl()}/api/agents/chat/stream/${encodeURIComponent(currentStreamId)}`;
      const url = isResume ? `${baseUrl}?resume=true` : baseUrl;
      console.log('[ResumableSSE] Subscribing to stream:', url, { isResume });

      const sse = new SSE(url, {
        headers: { Authorization: `Bearer ${token}` },
        method: 'GET',
      });
      sseRef.current = sse;

      sse.addEventListener('open', () => {
        console.log('[ResumableSSE] Stream connected');
        setAbortScroll(false);
        // Restore UI state on successful connection (including reconnection)
        setIsSubmitting(true);
        setShowStopButton(true);
        reconnectAttemptRef.current = 0;
      });

      sse.addEventListener('message', (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data);

          if (isLegacyAgentFinalEvent(data)) {
            console.log('[ResumableSSE] Received FINAL event', {
              aborted: data.aborted,
              conversationId: data.conversation?.conversationId,
              hasResponseMessage: !!data.responseMessage,
            });
            clearAllDrafts(currentSubmission.conversation?.conversationId);
            if (data.error?.message && !data.requestMessage && !data.responseMessage) {
              removeActiveJob(currentStreamId);
              errorHandler({
                data: {
                  text: data.error.message,
                },
                submission: currentSubmission as EventSubmission,
              });
              setIsSubmitting(false);
              setShowStopButton(false);
              setStreamId(null);
              reconnectAttemptRef.current = 0;
              (startupConfig?.balance?.enabled ?? false) && balanceQuery.refetch();
              return;
            }
            try {
              finalHandler(toFinalHandlerData(data), currentSubmission as EventSubmission);
            } catch (error) {
              console.error('[ResumableSSE] Error in finalHandler:', error);
              setIsSubmitting(false);
              setShowStopButton(false);
            }
            // Clear handler maps on stream completion to prevent memory leaks
            clearStepMaps();
            // Optimistically remove from active jobs
            removeActiveJob(currentStreamId);
            (startupConfig?.balance?.enabled ?? false) && balanceQuery.refetch();
            sse.close();
            setStreamId(null);
            return;
          }

          if (isLegacyAgentCreatedEvent(data)) {
            console.log('[ResumableSSE] Received CREATED event', {
              messageId: data.message?.messageId,
              conversationId: data.message?.conversationId,
            });
            const runId = v4();
            setActiveRunId(runId);
            userMessage = {
              ...userMessage,
              ...data.message,
              overrideParentMessageId: userMessage.overrideParentMessageId,
            };
            createdHandler(toCreatedHandlerData(data), {
              ...currentSubmission,
              userMessage,
            } as EventSubmission);
            return;
          }

          if (isLegacyAgentAttachmentEvent(data)) {
            attachmentHandler({
              data: data.data as TAttachment,
              submission: currentSubmission as EventSubmission,
            });
            return;
          }

          const stepEvent = toStepHandlerEvent(data);
          if (stepEvent) {
            stepHandler(stepEvent, { ...currentSubmission, userMessage } as EventSubmission);
            return;
          }

          if (isLegacyAgentSyncEvent(data)) {
            console.log('[ResumableSSE] SYNC received', {
              runSteps: data.resumeState.runSteps.length,
              pendingEvents: data.pendingEvents.length,
            });

            const pendingCreatedEvents = data.pendingEvents.filter(
              (pendingEvent): pendingEvent is LegacyCreatedEvent =>
                isLegacyAgentCreatedEvent(pendingEvent),
            );
            if (pendingCreatedEvents.length === 0) {
              announceReplyStart();
            }

            const runId = v4();
            setActiveRunId(runId);
            userMessage = {
              ...userMessage,
              ...data.resumeState.userMessage,
              overrideParentMessageId: userMessage.overrideParentMessageId,
            };
            currentSubmission = {
              ...currentSubmission,
              userMessage,
              initialResponse: {
                ...(currentSubmission.initialResponse as TMessage),
                messageId: data.resumeState.responseMessageId,
                parentMessageId: userMessage.messageId,
                conversationId:
                  userMessage.conversationId ?? currentSubmission.conversation?.conversationId,
              } as TMessage,
            };
            submissionRef.current = currentSubmission;

            for (const pendingCreatedEvent of pendingCreatedEvents) {
              userMessage = {
                ...userMessage,
                ...pendingCreatedEvent.message,
                overrideParentMessageId: userMessage.overrideParentMessageId,
              };
              createdHandler(toCreatedHandlerData(pendingCreatedEvent), {
                ...currentSubmission,
                userMessage,
              } as EventSubmission);
            }

            for (const runStep of data.resumeState.runSteps) {
              stepHandler({ event: StepEvents.ON_RUN_STEP, data: runStep }, {
                ...currentSubmission,
                userMessage,
              } as EventSubmission);
            }

            const aggregatedContent = data.resumeState.aggregatedContent;
            if (aggregatedContent && aggregatedContent.length > 0) {
              const messages = getMessages() ?? [];
              const userMsgId = data.resumeState.userMessage.messageId;
              const responseMessageId = data.resumeState.responseMessageId;
              const restoredContent = normalizeAggregatedContent(aggregatedContent);
              const responseIdx = messages.findIndex((m) => m.messageId === responseMessageId);

              console.log('[ResumableSSE] SYNC update', {
                userMsgId,
                responseMessageId,
                responseIdx,
                foundMessageId: responseIdx >= 0 ? messages[responseIdx]?.messageId : null,
                messagesCount: messages.length,
                aggregatedContentLength: restoredContent.length,
              });

              if (responseIdx >= 0) {
                const updated = [...messages];
                const oldContent = updated[responseIdx]?.content;
                updated[responseIdx] = {
                  ...updated[responseIdx],
                  content: restoredContent,
                };
                console.log('[ResumableSSE] SYNC updating message', {
                  messageId: updated[responseIdx]?.messageId,
                  oldContentLength: Array.isArray(oldContent) ? oldContent.length : 0,
                  newContentLength: restoredContent.length,
                });
                setMessages(updated);
                resetContentHandler();
                syncStepMessage(updated[responseIdx]);
                console.log('[ResumableSSE] SYNC complete, handlers synced');
              } else {
                const newMessage = {
                  messageId: responseMessageId,
                  parentMessageId: userMsgId,
                  conversationId: currentSubmission.conversation?.conversationId ?? '',
                  text: '',
                  content: restoredContent,
                  isCreatedByUser: false,
                } as TMessage;
                setMessages([...messages, newMessage]);
                resetContentHandler();
                syncStepMessage(newMessage);
              }
            }

            if (data.pendingEvents.length > 0) {
              console.log(`[ResumableSSE] Replaying ${data.pendingEvents.length} pending events`);
              for (const pendingEvent of data.pendingEvents) {
                const submission = { ...currentSubmission, userMessage } as EventSubmission;

                if (isLegacyAgentCreatedEvent(pendingEvent)) {
                  continue;
                }

                if (isLegacyAgentAttachmentEvent(pendingEvent)) {
                  attachmentHandler({
                    data: pendingEvent.data as TAttachment,
                    submission,
                  });
                } else {
                  const pendingStepEvent = toStepHandlerEvent(pendingEvent);
                  if (pendingStepEvent) {
                    stepHandler(pendingStepEvent, submission);
                    continue;
                  }
                }
                if (isLegacyAgentContentEvent(pendingEvent)) {
                  const text = getStreamText(pendingEvent);
                  const { index } = pendingEvent;
                  if (text != null && index !== textIndex) {
                    textIndex = index;
                  }
                  contentHandler({ data: pendingEvent, submission });
                }
              }
            }

            setIsSubmitting(true);
            setShowStopButton(true);
            return;
          }

          if (isLegacyAgentContentEvent(data)) {
            const text = getStreamText(data);
            const { index } = data;
            if (text != null && index !== textIndex) {
              textIndex = index;
            }
            contentHandler({ data, submission: currentSubmission as EventSubmission });
            return;
          }
        } catch (error) {
          console.error('[ResumableSSE] Error processing message:', error);
        }
      });

      /**
       * Error event handler - handles HTTP-level failures and transport drops.
       * Application-level terminal errors must arrive as in-band final message events.
       *
       * Order matters: check responseCode first since HTTP errors may also include data.
       */
      sse.addEventListener('error', async (e: MessageEvent) => {
        (startupConfig?.balance?.enabled ?? false) && balanceQuery.refetch();

        /* @ts-ignore - sse.js types don't expose responseCode */
        const responseCode = e.responseCode;

        // 404 → job completed & was cleaned up; messages are persisted in DB.
        // Invalidate cache once so react-query refetches instead of showing an error.
        if (responseCode === 404) {
          const convoId = currentSubmission.conversation?.conversationId;
          console.log('[ResumableSSE] Stream 404, invalidating messages for:', convoId);
          sse.close();
          removeActiveJob(currentStreamId);
          clearAllDrafts(convoId);
          clearStepMaps();
          if (convoId) {
            queryClient.invalidateQueries({ queryKey: [QueryKeys.messages, convoId] });
            queryClient.removeQueries({ queryKey: streamStatusQueryKey(convoId) });
          }
          setIsSubmitting(false);
          setShowStopButton(false);
          setStreamId(null);
          reconnectAttemptRef.current = 0;
          return;
        }

        // Check for 401 and try to refresh token (same pattern as useSSE)
        if (responseCode === 401) {
          try {
            const refreshResponse = await request.refreshToken();
            const newToken = refreshResponse?.token ?? '';
            if (!newToken) {
              throw new Error('Token refresh failed.');
            }
            sse.headers = {
              Authorization: `Bearer ${newToken}`,
            };
            request.dispatchTokenUpdatedEvent(newToken);
            sse.stream();
            return;
          } catch (error) {
            console.log('[ResumableSSE] Token refresh failed:', error);
          }
        }

        if (!responseCode && e.data) {
          console.warn(
            '[ResumableSSE] Unexpected SSE error event payload received; treating as transport failure',
            { currentStreamId },
          );
        }

        // Network failure or unknown HTTP error - attempt reconnection with backoff
        console.log('[ResumableSSE] Stream error (transport failure) - will attempt reconnect', {
          responseCode,
          hasData: !!e.data,
        });

        if (reconnectAttemptRef.current < MAX_RETRIES) {
          // Increment counter BEFORE close() so abort handler knows we're reconnecting
          reconnectAttemptRef.current++;
          const delay = Math.min(1000 * Math.pow(2, reconnectAttemptRef.current - 1), 30000);

          console.log(
            `[ResumableSSE] Reconnecting in ${delay}ms (attempt ${reconnectAttemptRef.current}/${MAX_RETRIES})`,
          );

          sse.close();

          reconnectTimeoutRef.current = setTimeout(() => {
            if (submissionRef.current) {
              // Reconnect with isResume=true to get sync event with any missed content
              subscribeToStream(currentStreamId, submissionRef.current, true);
            }
          }, delay);

          // Keep UI in "submitting" state during reconnection attempts
          // so user knows we're still trying (abort handler may have reset these)
          setIsSubmitting(true);
          setShowStopButton(true);
        } else {
          console.error('[ResumableSSE] Max reconnect attempts reached');
          sse.close();
          errorHandler({ data: undefined, submission: currentSubmission as EventSubmission });
          // Optimistically remove from active jobs on max retries
          removeActiveJob(currentStreamId);
          setIsSubmitting(false);
          setShowStopButton(false);
          setStreamId(null);
        }
      });

      /**
       * Abort event - fired when sse.close() is called (intentional close).
       * This happens on cleanup/navigation OR when error handler closes to reconnect.
       * Only reset state if we're NOT in a reconnection cycle.
       */
      sse.addEventListener('abort', () => {
        // If we're in a reconnection cycle, don't reset state
        // (error handler will set up the reconnect timeout)
        if (reconnectAttemptRef.current > 0) {
          console.log('[ResumableSSE] Stream closed for reconnect - preserving state');
          return;
        }

        console.log('[ResumableSSE] Stream aborted (intentional close) - no reconnect');
        // Clear any pending reconnect attempts
        if (reconnectTimeoutRef.current) {
          clearTimeout(reconnectTimeoutRef.current);
          reconnectTimeoutRef.current = null;
        }
        // Reset UI state - useResumeOnLoad will restore if user returns to this conversation
        setIsSubmitting(false);
        setShowStopButton(false);
        setStreamId(null);
      });

      // Start the SSE connection
      sse.stream();

      // Debug hooks for testing reconnection vs clean close behavior (dev only)
      if (import.meta.env.DEV) {
        const debugWindow = window as Window & {
          __sse?: SSE;
          __killNetwork?: () => void;
          __closeClean?: () => void;
        };
        debugWindow.__sse = sse;

        /** Simulate network drop - triggers error event → reconnection */
        debugWindow.__killNetwork = () => {
          console.log('[Debug] Simulating network drop...');
          // @ts-ignore - sse.js types are incorrect, dispatchEvent actually takes Event
          sse.dispatchEvent(new Event('error'));
        };

        /** Simulate clean close (navigation away) - triggers abort event → no reconnection */
        debugWindow.__closeClean = () => {
          console.log('[Debug] Simulating clean close (navigation away)...');
          sse.close();
        };
      }
    },
    [
      token,
      setAbortScroll,
      setActiveRunId,
      setShowStopButton,
      finalHandler,
      createdHandler,
      announceReplyStart,
      attachmentHandler,
      stepHandler,
      contentHandler,
      resetContentHandler,
      syncStepMessage,
      clearStepMaps,
      errorHandler,
      setIsSubmitting,
      getMessages,
      setMessages,
      startupConfig?.balance?.enabled,
      balanceQuery,
      removeActiveJob,
      queryClient,
    ],
  );

  /**
   * Start generation (POST request that returns streamId)
   * Uses request.post which has axios interceptors for automatic token refresh.
   * Retries up to 3 times on network errors with exponential backoff.
   */
  const startGeneration = useCallback(
    async (currentSubmission: TSubmission): Promise<string | null> => {
      const payloadData = createPayload(currentSubmission);
      let { payload } = payloadData;
      payload = removeNullishValues(payload) as TPayload;

      clearStepMaps();

      const url = payloadData.server;

      const maxRetries = 3;
      let lastError: unknown = null;

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          // Use request.post which handles auth token refresh via axios interceptors
          const data = (await request.post(url, payload)) as { streamId: string };
          console.log('[ResumableSSE] Generation started:', { streamId: data.streamId });
          return data.streamId;
        } catch (error) {
          lastError = error;
          // Check if it's a network error (retry) vs server error (don't retry)
          const isNetworkError =
            error instanceof Error &&
            'code' in error &&
            (error.code === 'ERR_NETWORK' || error.code === 'ERR_INTERNET_DISCONNECTED');

          if (isNetworkError && attempt < maxRetries) {
            const delay = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
            console.log(
              `[ResumableSSE] Network error starting generation, retrying in ${delay}ms (attempt ${attempt}/${maxRetries})`,
            );
            await new Promise((resolve) => setTimeout(resolve, delay));
            continue;
          }

          // Don't retry: either not a network error or max retries reached
          break;
        }
      }

      console.error('[ResumableSSE] Error starting generation:', lastError);

      const axiosError = lastError as { response?: { data?: Record<string, unknown> } };
      const errorData = axiosError?.response?.data;
      if (errorData) {
        errorHandler({
          data: { text: JSON.stringify(errorData) },
          submission: currentSubmission as EventSubmission,
        });
      } else {
        errorHandler({ data: undefined, submission: currentSubmission as EventSubmission });
      }
      setIsSubmitting(false);
      return null;
    },
    [clearStepMaps, errorHandler, setIsSubmitting],
  );

  useEffect(() => {
    if (!submission || Object.keys(submission).length === 0) {
      console.log('[ResumableSSE] No submission, cleaning up');
      // Clear reconnect timeout if submission is cleared
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      // Close SSE but do NOT dispatch cancel - navigation should not abort
      if (sseRef.current) {
        sseRef.current.close();
        sseRef.current = null;
      }
      setStreamId(null);
      reconnectAttemptRef.current = 0;
      submissionRef.current = null;
      return;
    }

    const resumeStreamId = (submission as TSubmission & { resumeStreamId?: string }).resumeStreamId;
    console.log('[ResumableSSE] Effect triggered', {
      conversationId: submission.conversation?.conversationId,
      hasResumeStreamId: !!resumeStreamId,
      resumeStreamId,
      userMessageId: submission.userMessage?.messageId,
    });

    submissionRef.current = submission;

    const initStream = async () => {
      setIsSubmitting(true);
      setShowStopButton(true);

      if (resumeStreamId) {
        // Resume: just subscribe to existing stream, don't start new generation
        console.log('[ResumableSSE] Resuming existing stream:', resumeStreamId);
        setStreamId(resumeStreamId);
        // Optimistically add to active jobs (in case it's not already there)
        addActiveJob(resumeStreamId);
        subscribeToStream(resumeStreamId, submission, true); // isResume=true
      } else {
        // New generation: start and then subscribe
        console.log('[ResumableSSE] Starting NEW generation');
        const newStreamId = await startGeneration(submission);
        if (newStreamId) {
          setStreamId(newStreamId);
          // Optimistically add to active jobs
          addActiveJob(newStreamId);
          // Queue title generation if this is a new conversation (first message)
          const isNewConvo = submission.userMessage?.parentMessageId === Constants.NO_PARENT;
          if (isNewConvo) {
            queueTitleGeneration(newStreamId);
          }
          subscribeToStream(newStreamId, submission);
        } else {
          console.error('[ResumableSSE] Failed to get streamId from startGeneration');
        }
      }
    };

    initStream();

    return () => {
      console.log('[ResumableSSE] Cleanup - closing SSE, resetting UI state');
      // Cleanup on unmount/navigation - close connection but DO NOT abort backend
      // Reset UI state so it doesn't leak to other conversations
      // If user returns to this conversation, useResumeOnLoad will restore the state
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      // Reset reconnect counter before closing (so abort handler doesn't think we're reconnecting)
      reconnectAttemptRef.current = 0;
      if (sseRef.current) {
        sseRef.current.close();
        sseRef.current = null;
      }
      // Clear handler maps to prevent memory leaks and stale state
      clearStepMaps();
      // Reset UI state on cleanup - useResumeOnLoad will restore if needed
      setIsSubmitting(false);
      setShowStopButton(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submission]);

  return { streamId };
}
