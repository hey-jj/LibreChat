import {
  isLegacyAgentContentEvent,
  isLegacyAgentCreatedEvent,
  isLegacyAgentFinalEvent,
  isLegacyAgentServerSentEvent,
  isLegacyAgentSyncEvent,
} from '~/hooks/SSE/legacyAgentStream';

describe('legacyAgentStream', () => {
  it('accepts a created event without streamId', () => {
    const event = {
      created: true,
      message: {
        messageId: 'user-msg-1',
        conversationId: 'conv-1',
        text: 'Hello',
      },
    };

    expect(isLegacyAgentCreatedEvent(event)).toBe(true);
    expect(isLegacyAgentServerSentEvent(event)).toBe(true);
  });

  it('accepts a sync event with created, attachment, stream, and content pending events', () => {
    const event = {
      sync: true,
      resumeState: {
        runSteps: [],
        aggregatedContent: [{ type: 'text', text: 'Hello again' }],
        userMessage: {
          messageId: 'user-msg-1',
        },
        responseMessageId: 'resp-msg-1',
      },
      pendingEvents: [
        {
          created: true,
          message: {
            messageId: 'user-msg-1',
            conversationId: 'conv-1',
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
            id: 'step-1',
          },
        },
        {
          type: 'text',
          text: 'delta',
          index: 0,
          messageId: 'resp-msg-1',
          conversationId: 'conv-1',
          userMessageId: 'user-msg-1',
          thread_id: 'conv-1',
        },
      ],
    };

    expect(isLegacyAgentSyncEvent(event)).toBe(true);
    expect(isLegacyAgentServerSentEvent(event)).toBe(true);
  });

  it('rejects a sync event whose pending payload falls outside the union', () => {
    const event = {
      sync: true,
      resumeState: {
        runSteps: [],
        userMessage: {
          messageId: 'user-msg-1',
        },
        responseMessageId: 'resp-msg-1',
      },
      pendingEvents: [{ unexpected: true }],
    };

    expect(isLegacyAgentSyncEvent(event)).toBe(false);
    expect(isLegacyAgentServerSentEvent(event)).toBe(false);
  });

  it('rejects unknown raw step event names', () => {
    const event = {
      event: 'test',
      data: {
        id: 'step-1',
      },
    };

    expect(isLegacyAgentServerSentEvent(event)).toBe(false);
  });

  it.each([
    {
      resumeState: {
        runSteps: [],
        userMessage: {},
        responseMessageId: 'resp-msg-1',
      },
    },
    {
      resumeState: {
        runSteps: [],
        userMessage: {
          messageId: 'user-msg-1',
        },
      },
    },
  ])('rejects a sync event without exact resume ids', ({ resumeState }) => {
    const event = {
      sync: true,
      resumeState,
      pendingEvents: [],
    };

    expect(isLegacyAgentSyncEvent(event)).toBe(false);
    expect(isLegacyAgentServerSentEvent(event)).toBe(false);
  });

  it.each([
    {
      label: 'non-array runSteps',
      resumeState: {
        runSteps: {},
        userMessage: {
          messageId: 'user-msg-1',
        },
        responseMessageId: 'resp-msg-1',
      },
    },
    {
      label: 'non-array aggregatedContent',
      resumeState: {
        runSteps: [],
        aggregatedContent: {},
        userMessage: {
          messageId: 'user-msg-1',
        },
        responseMessageId: 'resp-msg-1',
      },
    },
  ])('rejects a sync event with %s', ({ resumeState }) => {
    const event = {
      sync: true,
      resumeState,
      pendingEvents: [],
    };

    expect(isLegacyAgentSyncEvent(event)).toBe(false);
    expect(isLegacyAgentServerSentEvent(event)).toBe(false);
  });

  it('recognizes standalone final and content events', () => {
    const finalEvent = {
      final: true,
      conversation: { conversationId: 'conv-1' },
    };
    const contentEvent = {
      type: 'text',
      text: 'streamed text',
      index: 0,
      messageId: 'resp-msg-1',
      conversationId: 'conv-1',
      userMessageId: 'user-msg-1',
      thread_id: 'conv-1',
    };

    expect(isLegacyAgentFinalEvent(finalEvent)).toBe(true);
    expect(isLegacyAgentContentEvent(contentEvent)).toBe(true);
    expect(isLegacyAgentServerSentEvent(finalEvent)).toBe(true);
    expect(isLegacyAgentServerSentEvent(contentEvent)).toBe(true);
  });
});
