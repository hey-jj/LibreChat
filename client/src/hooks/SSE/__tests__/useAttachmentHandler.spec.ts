import type { TAttachment } from 'librechat-data-provider';
import { normalizeAttachmentData } from '~/utils/attachments';

describe('normalizeAttachmentData', () => {
  it('normalizes snake_case fields from responses attachment events', () => {
    const input = {
      type: 'image/png',
      file_id: 'file-1',
      filename: 'generated.png',
      message_id: 'msg-1',
      conversation_id: 'conv-1',
      tool_call_id: 'tool-1',
      url: 'https://example.com/generated.png',
    } as unknown as TAttachment;

    const normalized = normalizeAttachmentData(input);

    expect(normalized.messageId).toBe('msg-1');
    expect(normalized.conversationId).toBe('conv-1');
    expect(normalized.toolCallId).toBe('tool-1');
    expect((normalized as { filepath?: string }).filepath).toBe(
      'https://example.com/generated.png',
    );
  });

  it('preserves existing camelCase values when present', () => {
    const input = {
      type: 'image/png',
      file_id: 'file-2',
      messageId: 'msg-camel',
      conversationId: 'conv-camel',
      toolCallId: 'tool-camel',
      filepath: 'https://example.com/camel.png',
      message_id: 'msg-snake',
      conversation_id: 'conv-snake',
      tool_call_id: 'tool-snake',
      url: 'https://example.com/snake.png',
    } as unknown as TAttachment;

    const normalized = normalizeAttachmentData(input);

    expect(normalized.messageId).toBe('msg-camel');
    expect(normalized.conversationId).toBe('conv-camel');
    expect(normalized.toolCallId).toBe('tool-camel');
    expect((normalized as { filepath?: string }).filepath).toBe('https://example.com/camel.png');
  });
});
