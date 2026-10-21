import { jest } from '@jest/globals';

type MockQueryResult = { rows: unknown[]; rowCount?: number };
const mockQuery: jest.MockedFunction<
  (text: string, params?: unknown[]) => Promise<MockQueryResult>
> = jest.fn();

jest.unstable_mockModule('../db/connection.js', () => ({
  default: { query: mockQuery },
  query: mockQuery,
  getClient: jest.fn(),
  closePool: jest.fn(),
}));

const { WebhookService, redactFailureSummary } = await import('../services/webhookService.js');

describe('webhook dead-letter and re-drive', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    jest.clearAllMocks();
    global.fetch = originalFetch;
  });

  it('redacts urls and long tokens from failure summaries', () => {
    const out = redactFailureSummary(
      `connect failed https://x.example/hook?t=abc ${'a'.repeat(40)}`,
    );
    expect(out).not.toContain('https://');
    expect(out).not.toContain('aaaaaaaa');
  });

  it('dead-letters a delivery when retries are exhausted without changing the payload', async () => {
    global.fetch = (jest.fn() as jest.Mock<() => Promise<unknown>>).mockResolvedValue({
      ok: false,
      status: 500,
    }) as unknown as typeof fetch;
    mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });

    await WebhookService.retryWebhookDelivery(
      1,
      2,
      'https://consumer.example',
      'secret',
      'evt-1',
      'LoanApproved',
      { eventId: 'evt-1' },
      3,
    );

    const [sql, params] = mockQuery.mock.calls[0]!;
    expect(sql).toContain('dead_lettered_at');
    expect(sql).not.toContain('payload');
    expect(params![6]).toBeInstanceOf(Date);
    expect(params![7]).toBe('Webhook returned status 500');
  });

  it('sends the stable event id and generation headers on retry', async () => {
    const fetchMock = jest.fn<(...args: unknown[]) => Promise<{ ok: boolean; status: number }>>();
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    global.fetch = fetchMock as unknown as typeof fetch;
    mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });

    await WebhookService.retryWebhookDelivery(
      1,
      2,
      'https://consumer.example',
      'rotated-secret',
      'evt-1',
      'LoanApproved',
      { eventId: 'evt-1' },
      0,
      3,
    );

    const init = fetchMock.mock.calls[0]![1] as { headers: Record<string, string> };
    expect(init.headers['x-remitlend-event-id']).toBe('evt-1');
    expect(init.headers['x-remitlend-delivery-generation']).toBe('3');
    expect(init.headers['x-remitlend-signature']).toMatch(/^sha256=/);
  });

  it('re-drives a dead-lettered delivery and bumps the generation', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 7, event_id: 'evt-7', delivery_generation: 2 }],
      rowCount: 1,
    });
    const result = await WebhookService.redriveDeadLetter(7, 'GADMIN');
    expect(result).toEqual({ deliveryId: 7, eventId: 'evt-7', generation: 2 });
    expect(mockQuery.mock.calls[0]![0]).toContain('dead_lettered_at IS NOT NULL');
  });

  it('rejects duplicate or concurrent re-drives when the conditional update matches nothing', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 7, event_id: 'evt-7', delivery_generation: 2 }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const [a, b] = [
      await WebhookService.redriveDeadLetter(7, 'GADMIN'),
      await WebhookService.redriveDeadLetter(7, 'GADMIN2'),
    ];
    expect(a).not.toBeNull();
    expect(b).toBeNull();
  });
});
