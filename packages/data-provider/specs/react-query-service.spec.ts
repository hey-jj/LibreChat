import { useQuery } from '@tanstack/react-query';
import * as dataService from '../src/data-service';
import { QueryKeys } from '../src/keys';
import { useUserKeyQuery } from '../src/react-query/react-query-service';

jest.mock('@tanstack/react-query', () => ({
  useMutation: jest.fn(),
  useQueryClient: jest.fn(),
  useQuery: jest.fn(),
}));

jest.mock('../src/data-service', () => ({
  userKeyQuery: jest.fn(),
}));

type QueryOptions = {
  retry?: boolean;
};

describe('useUserKeyQuery', () => {
  const mockedUseQuery = useQuery as unknown as jest.Mock;
  const mockedUserKeyQuery = dataService.userKeyQuery as jest.MockedFunction<
    typeof dataService.userKeyQuery
  >;

  let capturedQueryFn:
    | (() => ReturnType<typeof dataService.userKeyQuery> | Promise<{ expiresAt: null }>)
    | undefined;
  let capturedOptions: QueryOptions | undefined;

  beforeEach(() => {
    jest.clearAllMocks();
    capturedQueryFn = undefined;
    capturedOptions = undefined;

    mockedUseQuery.mockImplementation((_queryKey, queryFn, options) => {
      capturedQueryFn = queryFn;
      capturedOptions = options;
      return { data: undefined };
    });
  });

  it('returns a null expiry without calling the API when the endpoint name is empty', async () => {
    useUserKeyQuery('');

    expect(mockedUseQuery).toHaveBeenCalledWith(
      [QueryKeys.name, ''],
      expect.any(Function),
      expect.objectContaining({ retry: false }),
    );
    await expect(capturedQueryFn?.()).resolves.toEqual({ expiresAt: null });
    expect(mockedUserKeyQuery).not.toHaveBeenCalled();
    expect(capturedOptions?.retry).toBe(false);
  });

  it('queries the endpoint-specific key when a name is provided', async () => {
    mockedUserKeyQuery.mockResolvedValue({
      expiresAt: 'never',
    } as Awaited<ReturnType<typeof dataService.userKeyQuery>>);

    useUserKeyQuery('openAI');

    await expect(capturedQueryFn?.()).resolves.toEqual({ expiresAt: 'never' });
    expect(mockedUserKeyQuery).toHaveBeenCalledWith('openAI');
  });
});
