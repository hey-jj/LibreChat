import { StepEvents } from 'librechat-data-provider';
import type {
  Agents,
  TAttachment,
  TContentData,
  TConversation,
  TMessage,
} from 'librechat-data-provider';

type EventRecord = Record<string, unknown>;
type LegacyFinalMessage = {
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
type LegacyFinalConversation = {
  conversationId?: string;
  title?: string | null;
  endpoint?: TConversation['endpoint'];
  endpointType?: TConversation['endpointType'];
  model?: string | null;
  iconURL?: string | null;
};
type SyncResumeState = Agents.ResumeState & {
  userMessage: NonNullable<Agents.ResumeState['userMessage']> & {
    messageId: string;
  };
  responseMessageId: string;
};

export type LegacyAttachmentEvent = {
  event: 'attachment';
  data: TAttachment;
};

export type LegacyStepEvent =
  | { event: StepEvents.ON_RUN_STEP; data: Agents.RunStep }
  | { event: StepEvents.ON_AGENT_UPDATE; data: Agents.AgentUpdate }
  | { event: StepEvents.ON_MESSAGE_DELTA; data: Agents.MessageDeltaEvent }
  | { event: StepEvents.ON_REASONING_DELTA; data: Agents.ReasoningDeltaEvent }
  | { event: StepEvents.ON_RUN_STEP_DELTA; data: Agents.RunStepDeltaEvent }
  | { event: StepEvents.ON_RUN_STEP_COMPLETED; data: { result: Agents.ToolEndEvent } }
  | { event: StepEvents.ON_SUMMARIZE_START; data: Agents.SummarizeStartEvent }
  | { event: StepEvents.ON_SUMMARIZE_DELTA; data: Agents.SummarizeDeltaEvent }
  | { event: StepEvents.ON_SUMMARIZE_COMPLETE; data: Agents.SummarizeCompleteEvent };

export type LegacyCreatedEvent = {
  created: true;
  message: {
    messageId: string;
    parentMessageId?: string | null;
    conversationId?: string | null;
    text?: string;
    sender?: string;
    isCreatedByUser?: boolean;
  };
  streamId?: string;
};

export type LegacyContentEvent = TContentData;

export type LegacyReplayEvent =
  | LegacyCreatedEvent
  | LegacyAttachmentEvent
  | LegacyStepEvent
  | LegacyContentEvent;

export type LegacySyncEvent = {
  sync: true;
  resumeState: SyncResumeState;
  pendingEvents: LegacyReplayEvent[];
};

export type LegacyFinalEvent = {
  final: true;
  requestMessage?: LegacyFinalMessage | null;
  responseMessage?: LegacyFinalMessage | null;
  conversation?: LegacyFinalConversation | null;
  title?: string;
  aborted?: boolean;
  earlyAbort?: boolean;
  runMessages?: LegacyFinalMessage[];
  error?: { message: string };
};

function isEventRecord(value: unknown): value is EventRecord {
  return value != null && typeof value === 'object';
}

function hasNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function hasResumeState(value: unknown): value is SyncResumeState {
  if (!isEventRecord(value)) {
    return false;
  }

  return (
    Array.isArray(value.runSteps) &&
    (value.aggregatedContent == null || Array.isArray(value.aggregatedContent)) &&
    isEventRecord(value.userMessage) &&
    hasNonEmptyString(value.userMessage.messageId) &&
    hasNonEmptyString(value.responseMessageId)
  );
}

export function isLegacyAgentFinalEvent(value: unknown): value is LegacyFinalEvent {
  return isEventRecord(value) && value.final === true;
}

export function isLegacyAgentCreatedEvent(value: unknown): value is LegacyCreatedEvent {
  return (
    isEventRecord(value) &&
    value.created === true &&
    isEventRecord(value.message) &&
    typeof value.message.messageId === 'string'
  );
}

export function isLegacyAgentAttachmentEvent(value: unknown): value is LegacyAttachmentEvent {
  return (
    isEventRecord(value) &&
    value.event === 'attachment' &&
    isEventRecord(value.data) &&
    typeof value.data.messageId === 'string'
  );
}

export function isLegacyAgentStreamEvent(value: unknown): value is LegacyStepEvent {
  if (
    !isEventRecord(value) ||
    value.event === 'attachment' ||
    typeof value.event !== 'string' ||
    !isEventRecord(value.data)
  ) {
    return false;
  }

  switch (value.event) {
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

export function isLegacyAgentContentEvent(value: unknown): value is LegacyContentEvent {
  return (
    isEventRecord(value) &&
    typeof value.type === 'string' &&
    typeof value.messageId === 'string' &&
    typeof value.conversationId === 'string' &&
    typeof value.userMessageId === 'string' &&
    typeof value.thread_id === 'string' &&
    typeof value.index === 'number'
  );
}

export function isLegacyAgentReplayEvent(value: unknown): value is LegacyReplayEvent {
  return (
    isLegacyAgentCreatedEvent(value) ||
    isLegacyAgentAttachmentEvent(value) ||
    isLegacyAgentStreamEvent(value) ||
    isLegacyAgentContentEvent(value)
  );
}

export function isLegacyAgentSyncEvent(value: unknown): value is LegacySyncEvent {
  return (
    isEventRecord(value) &&
    value.sync === true &&
    hasResumeState(value.resumeState) &&
    Array.isArray(value.pendingEvents) &&
    value.pendingEvents.every(isLegacyAgentReplayEvent)
  );
}

export function isLegacyAgentServerSentEvent(
  value: unknown,
): value is LegacyReplayEvent | LegacySyncEvent | LegacyFinalEvent {
  return (
    isLegacyAgentFinalEvent(value) ||
    isLegacyAgentCreatedEvent(value) ||
    isLegacyAgentSyncEvent(value) ||
    isLegacyAgentReplayEvent(value)
  );
}
