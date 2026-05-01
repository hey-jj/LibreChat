import type { SearchMessagesListParams, SearchMessagesListResponse } from './queries';

describe('SearchMessagesList contract', () => {
  it('captures the explicit reusable search-mode request and response shape', () => {
    const params: SearchMessagesListParams = {
      search: 'alpha',
      cursor: '2026-04-21T00:00:00.000Z',
      pageSize: 2,
    };

    const response: SearchMessagesListResponse = {
      messages: [
        {
          messageId: 'msg-1',
          conversationId: 'convo-1',
          text: 'alpha result',
          title: 'Alpha',
          searchResult: true,
          model: 'gpt-4.1',
          isCreatedByUser: false,
          endpoint: 'openAI',
          iconURL: 'https://example.com/icon.png',
        },
      ],
      nextCursor: '2026-04-21T00:00:00.000Z',
    };

    expect(params.search).toBe('alpha');
    expect(response.messages[0]).toMatchObject({
      messageId: 'msg-1',
      conversationId: 'convo-1',
      title: 'Alpha',
    });
  });
});
