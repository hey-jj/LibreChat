import type { TAttachment, TFile } from 'librechat-data-provider';

type LegacyAttachmentShape = {
  message_id?: string;
  conversation_id?: string;
  tool_call_id?: string;
  url?: string;
};

export function normalizeAttachmentData(data: TAttachment): TAttachment {
  const legacy = data as TAttachment & LegacyAttachmentShape;

  return {
    ...legacy,
    messageId: legacy.messageId ?? legacy.message_id,
    conversationId: legacy.conversationId ?? legacy.conversation_id,
    toolCallId: legacy.toolCallId ?? legacy.tool_call_id,
    filepath: (legacy as TFile).filepath ?? legacy.url,
  };
}

function attachmentKey(data: TAttachment): string {
  const fileData = data as Partial<TFile>;
  const type = String(data.type ?? '');
  const toolCallId = String(data.toolCallId ?? '');
  const fileId = String(fileData.file_id ?? '');
  const filepath = String(fileData.filepath ?? '');

  if (type || toolCallId || fileId || filepath) {
    return `${type}|${toolCallId}|${fileId}|${filepath}`;
  }

  return JSON.stringify(data);
}

export function mergeAttachments({
  primary,
  secondary,
}: {
  primary?: TAttachment[];
  secondary?: TAttachment[];
}): TAttachment[] {
  const normalized = [...(primary ?? []), ...(secondary ?? [])].map(normalizeAttachmentData);
  const seen = new Set<string>();
  const deduped: TAttachment[] = [];

  for (const attachment of normalized) {
    const key = attachmentKey(attachment);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(attachment);
  }

  return deduped;
}
