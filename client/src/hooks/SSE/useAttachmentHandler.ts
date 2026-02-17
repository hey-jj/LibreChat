import { useSetRecoilState } from 'recoil';
import type { QueryClient } from '@tanstack/react-query';
import { QueryKeys, Tools } from 'librechat-data-provider';
import type {
  MemoriesResponse,
  EventSubmission,
  TAttachment,
  TFile,
} from 'librechat-data-provider';
import { handleMemoryArtifact } from '~/utils/memory';
import store from '~/store';

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

export default function useAttachmentHandler(queryClient?: QueryClient) {
  const setAttachmentsMap = useSetRecoilState(store.messageAttachmentsMap);

  return ({ data }: { data: TAttachment; submission: EventSubmission }) => {
    const normalizedData = normalizeAttachmentData(data);
    const { messageId } = normalizedData;

    if (!messageId) {
      return;
    }

    const fileData = normalizedData as TFile;
    if (
      queryClient &&
      fileData?.file_id &&
      fileData?.filepath &&
      !fileData.filepath.includes('/api/files')
    ) {
      queryClient.setQueryData([QueryKeys.files], (oldData: TFile[] | undefined) => {
        if (!oldData) {
          return [fileData];
        }
        const existingIndex = oldData.findIndex((file) => file.file_id === fileData.file_id);
        if (existingIndex > -1) {
          const updated = [...oldData];
          updated[existingIndex] = { ...oldData[existingIndex], ...fileData };
          return updated;
        }
        return [fileData, ...oldData];
      });
    }

    if (
      queryClient &&
      normalizedData.type === Tools.memory &&
      normalizedData[Tools.memory] != null
    ) {
      const memoryArtifact = normalizedData[Tools.memory];

      queryClient.setQueryData([QueryKeys.memories], (oldData: MemoriesResponse | undefined) => {
        if (!oldData) {
          return oldData;
        }

        return handleMemoryArtifact({ memoryArtifact, currentData: oldData }) || oldData;
      });
    }

    setAttachmentsMap((prevMap) => {
      const messageAttachments =
        (prevMap as Record<string, TAttachment[] | undefined>)[messageId] || [];
      return {
        ...prevMap,
        [messageId]: [...messageAttachments, normalizedData],
      };
    });
  };
}
