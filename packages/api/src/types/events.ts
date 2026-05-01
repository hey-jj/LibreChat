import { StepEvents } from 'librechat-data-provider';
import type {
  Agents,
  TAttachment,
  TContentData,
  TConversation,
  TMessage,
} from 'librechat-data-provider';

type EventDataRecord = Record<string, unknown>;
type RequiredUserMessageMeta = NonNullable<Agents.ResumeState['userMessage']> & {
  messageId: string;
};
type CreatedEventMessage = {
  messageId: string;
  parentMessageId?: string | null;
  conversationId?: string | null;
  text?: string;
  sender?: string;
  isCreatedByUser?: boolean;
};
type FinalEventMessage = {
  messageId?: string;
  parentMessageId?: string | null;
  conversationId?: string | null;
  text?: string;
  content?: TMessage['content'] | Agents.MessageContentComplex[];
  sender?: string;
  isCreatedByUser?: boolean;
  unfinished?: boolean;
  attachments?: TMessage['attachments'];
  files?: TMessage['files'];
  model?: string | null;
  endpoint?: string;
  iconURL?: string | null;
  title?: string | null;
  error?: boolean | string;
};
type FinalEventConversation = {
  conversationId?: string;
  title?: string | null;
  endpoint?: TConversation['endpoint'];
  endpointType?: TConversation['endpointType'];
  model?: string | null;
  iconURL?: string | null;
};
export type CanonicalResumeState = Agents.ResumeState & {
  userMessage: RequiredUserMessageMeta;
  responseMessageId: string;
};

/** Attachment event emitted during streaming */
export type AttachmentEvent = {
  event: 'attachment';
  data: TAttachment;
};

/** Internal catch-all stream event shape. Not the reusable shared client contract. */
export type StreamEvent = {
  event: string;
  data: string | EventDataRecord;
};

/** Reusable step events shared across web, localservice, and SwiftUI. */
export type StepEvent =
  | { event: StepEvents.ON_RUN_STEP; data: Agents.RunStep }
  | { event: StepEvents.ON_AGENT_UPDATE; data: Agents.AgentUpdate }
  | { event: StepEvents.ON_MESSAGE_DELTA; data: Agents.MessageDeltaEvent }
  | { event: StepEvents.ON_REASONING_DELTA; data: Agents.ReasoningDeltaEvent }
  | { event: StepEvents.ON_RUN_STEP_DELTA; data: Agents.RunStepDeltaEvent }
  | { event: StepEvents.ON_RUN_STEP_COMPLETED; data: { result: Agents.ToolEndEvent } }
  | { event: StepEvents.ON_SUMMARIZE_START; data: Agents.SummarizeStartEvent }
  | { event: StepEvents.ON_SUMMARIZE_DELTA; data: Agents.SummarizeDeltaEvent }
  | { event: StepEvents.ON_SUMMARIZE_COMPLETE; data: Agents.SummarizeCompleteEvent };

/** Control event emitted when user message is created and generation starts */
export type CreatedEvent = {
  created: true;
  message: CreatedEventMessage;
  /** Present for resumable streams; omitted on the legacy direct SSE path. */
  streamId?: string;
};

/** SSE content chunk emitted while the response body is streaming */
export type ContentEvent = TContentData;

/** Events that can truthfully be replayed after a resume snapshot */
export type ReplayEvent = CreatedEvent | AttachmentEvent | StepEvent | ContentEvent;

/** Resume/sync control event emitted before replaying live events on reconnect */
export type SyncEvent = {
  sync: true;
  resumeState: CanonicalResumeState;
  pendingEvents: ReplayEvent[];
};

/** Canonical in-band SSE error payload emitted on the message channel */
export type InBandErrorPayload = {
  message: string;
  code?: string;
};

export type FinalMessageFields = FinalEventMessage;

/** Terminal event emitted when generation completes or is aborted */
export type FinalEvent = {
  final: true;
  requestMessage?: FinalMessageFields | null;
  responseMessage?: FinalMessageFields | null;
  conversation?: FinalEventConversation | null;
  title?: string;
  aborted?: boolean;
  earlyAbort?: boolean;
  runMessages?: FinalMessageFields[];
  /** Top-level event error for terminal stream failures */
  error?: InBandErrorPayload;
};

/** Terminal in-band SSE error event emitted on the message channel */
export type FinalErrorEvent = Omit<FinalEvent, 'error'> & {
  error: InBandErrorPayload;
};

/** Exact reusable message-channel contract used by the shipped resumable stream. */
export type ReusableServerSentEvent = ReplayEvent | SyncEvent | FinalEvent;

export type ServerSentEvent = ReusableServerSentEvent | StreamEvent;

function hasNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object';
}

function isStepEventName(value: unknown): value is StepEvent['event'] {
  switch (value) {
    case StepEvents.ON_RUN_STEP:
    case StepEvents.ON_AGENT_UPDATE:
    case StepEvents.ON_MESSAGE_DELTA:
    case StepEvents.ON_REASONING_DELTA:
    case StepEvents.ON_RUN_STEP_DELTA:
    case StepEvents.ON_RUN_STEP_COMPLETED:
    case StepEvents.ON_SUMMARIZE_START:
    case StepEvents.ON_SUMMARIZE_DELTA:
    case StepEvents.ON_SUMMARIZE_COMPLETE:
      return true;
    default:
      return false;
  }
}

export function isCanonicalResumeState(resumeState: unknown): resumeState is CanonicalResumeState {
  return (
    isObjectRecord(resumeState) &&
    Array.isArray(resumeState.runSteps) &&
    (resumeState.aggregatedContent == null || Array.isArray(resumeState.aggregatedContent)) &&
    isObjectRecord(resumeState.userMessage) &&
    hasNonEmptyString(resumeState.userMessage.messageId) &&
    hasNonEmptyString(resumeState.responseMessageId)
  );
}

export function isCreatedEvent(value: unknown): value is CreatedEvent {
  return (
    isObjectRecord(value) &&
    value.created === true &&
    isObjectRecord(value.message) &&
    hasNonEmptyString(value.message.messageId)
  );
}

export function isAttachmentEvent(value: unknown): value is AttachmentEvent {
  return (
    isObjectRecord(value) &&
    value.event === 'attachment' &&
    isObjectRecord(value.data) &&
    hasNonEmptyString(value.data.messageId)
  );
}

export function isStepEvent(value: unknown): value is StepEvent {
  return isObjectRecord(value) && isStepEventName(value.event) && isObjectRecord(value.data);
}

export function isContentEvent(value: unknown): value is ContentEvent {
  return (
    isObjectRecord(value) &&
    typeof value.type === 'string' &&
    hasNonEmptyString(value.messageId) &&
    hasNonEmptyString(value.conversationId) &&
    hasNonEmptyString(value.userMessageId) &&
    hasNonEmptyString(value.thread_id) &&
    typeof value.index === 'number'
  );
}

export function isReplayEvent(value: unknown): value is ReplayEvent {
  return (
    isCreatedEvent(value) || isAttachmentEvent(value) || isStepEvent(value) || isContentEvent(value)
  );
}

export function isSyncEvent(value: unknown): value is SyncEvent {
  return (
    isObjectRecord(value) &&
    value.sync === true &&
    isCanonicalResumeState(value.resumeState) &&
    Array.isArray(value.pendingEvents) &&
    value.pendingEvents.every(isReplayEvent)
  );
}

export function createSyncEvent({
  resumeState,
  pendingEvents = [],
}: {
  resumeState: CanonicalResumeState;
  pendingEvents?: ReplayEvent[];
}): SyncEvent {
  return {
    sync: true,
    resumeState,
    pendingEvents,
  };
}

export function createFinalErrorEvent(message: string, code?: string): FinalErrorEvent {
  return {
    final: true,
    error: {
      message,
      ...(code != null ? { code } : {}),
    },
  };
}
