import { useMemo } from 'react';
import { useRecoilValue } from 'recoil';
import type { TAttachment } from 'librechat-data-provider';
import { useSearchResultsByTurn } from './useSearchResultsByTurn';
import { mergeAttachments } from '~/utils/attachments';
import store from '~/store';

export default function useAttachments({
  messageId,
  attachments,
}: {
  messageId?: string;
  attachments?: TAttachment[];
}) {
  const messageAttachmentsMap = useRecoilValue(store.messageAttachmentsMap);
  const streamedAttachments = messageAttachmentsMap[messageId ?? ''];
  const messageAttachments = useMemo(
    () => mergeAttachments({ primary: attachments, secondary: streamedAttachments }),
    [attachments, streamedAttachments],
  );

  const searchResults = useSearchResultsByTurn(messageAttachments);

  return {
    attachments: messageAttachments,
    searchResults,
  };
}
