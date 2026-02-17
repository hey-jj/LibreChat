import type { TAttachment } from 'librechat-data-provider';
import { mergeAttachments, normalizeAttachmentData } from './attachments';

describe('attachments utils', () => {
  it('normalizes snake_case payload from responses attachment events', () => {
    const normalized = normalizeAttachmentData({
      type: 'image/png',
      file_id: 'file-1',
      message_id: 'msg-1',
      conversation_id: 'conv-1',
      tool_call_id: 'tool-1',
      url: 'https://example.com/generated.png',
    } as unknown as TAttachment);

    expect(normalized.messageId).toBe('msg-1');
    expect(normalized.conversationId).toBe('conv-1');
    expect(normalized.toolCallId).toBe('tool-1');
    expect((normalized as { filepath?: string }).filepath).toBe(
      'https://example.com/generated.png',
    );
  });

  it('merges streamed and message attachments when message attachments is empty', () => {
    const streamed = [
      {
        type: 'image/png',
        file_id: 'file-stream',
        message_id: 'msg-1',
        tool_call_id: 'tool-1',
        url: 'https://example.com/stream.png',
      } as unknown as TAttachment,
    ];

    const merged = mergeAttachments({ primary: [], secondary: streamed });

    expect(merged).toHaveLength(1);
    expect(merged[0].toolCallId).toBe('tool-1');
    expect((merged[0] as { filepath?: string }).filepath).toBe('https://example.com/stream.png');
  });

  it('deduplicates identical attachments across message and streamed sources', () => {
    const messageAttachment = {
      type: 'image/png',
      file_id: 'file-1',
      toolCallId: 'tool-1',
      filepath: 'https://example.com/generated.png',
    } as unknown as TAttachment;

    const streamedAttachment = {
      type: 'image/png',
      file_id: 'file-1',
      tool_call_id: 'tool-1',
      url: 'https://example.com/generated.png',
    } as unknown as TAttachment;

    const merged = mergeAttachments({
      primary: [messageAttachment],
      secondary: [streamedAttachment],
    });

    expect(merged).toHaveLength(1);
    expect((merged[0] as { filepath?: string }).filepath).toBe(
      'https://example.com/generated.png',
    );
  });
});
