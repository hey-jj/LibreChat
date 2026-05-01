import { StepEvents } from 'librechat-data-provider';
import {
  createFinalErrorEvent,
  createSyncEvent,
  isCanonicalResumeState,
  type ReplayEvent,
  type ReusableServerSentEvent,
} from './events';

describe('reusable SSE event contract', () => {
  it('accepts the canonical sync envelope with explicit replay events', () => {
    const resumeState = {
      runSteps: [],
      aggregatedContent: [{ type: 'text', text: 'Recovered reply' }],
      userMessage: {
        messageId: 'user-msg-1',
        conversationId: 'conv-1',
        text: 'Hello',
      },
      responseMessageId: 'resp-msg-1',
      conversationId: 'conv-1',
      sender: 'Assistant',
    };

    expect(isCanonicalResumeState(resumeState)).toBe(true);

    const replayEvent: ReplayEvent = {
      event: StepEvents.ON_RUN_STEP,
      data: {
        id: 'step-1',
        type: 'tool_calls',
        index: 0,
        stepDetails: { type: 'tool_calls', tool_calls: [] },
        usage: null,
      },
    };

    const syncEvent: ReusableServerSentEvent = createSyncEvent({
      resumeState,
      pendingEvents: [replayEvent],
    });

    expect(syncEvent).toEqual({
      sync: true,
      resumeState,
      pendingEvents: [replayEvent],
    });
  });

  it('creates the canonical in-band final error payload', () => {
    expect(createFinalErrorEvent('Generation failed')).toEqual({
      final: true,
      error: { message: 'Generation failed' },
    });

    expect(createFinalErrorEvent('Resume failed', 'canonical_resume_state_unavailable')).toEqual({
      final: true,
      error: {
        message: 'Resume failed',
        code: 'canonical_resume_state_unavailable',
      },
    });
  });
});
