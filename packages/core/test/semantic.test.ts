import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_DATASET_ID, routeQuestion } from '@datera/core';
import {
  fixturePaths,
  openTestWorkspace,
  startStubModelServer,
  testPorts,
  type FixturePaths,
  type StubModelServer,
  type TestWorkspace,
} from '@datera/testkit';

/**
 * Phase 4 — the semantic path (spec §5, acceptance §12.5).
 *
 * The routing decision is computed in code from the question and the dataset's shape
 * (§1.5): asking a model which path to take would make the one decision that determines
 * what the user is charged for, and how long they wait, itself a model call.
 */
/**
 * §12.5's second half, which was only ever claimed in a describe name.
 *
 * "Structured questions route to SQL (no embeddings)" is two assertions. The routing
 * decision was tested; the *cost* was not — and the cost is the reason the criterion
 * exists. A structured question that quietly embedded the dataset first would still route
 * correctly, still return the right answer, and still be wrong in the way that matters:
 * slower, and billed.
 *
 * Asserted against the model server's captured requests, so it measures what actually
 * went over the wire rather than what the code intended.
 */
describe('§12.5 a structured question computes no embeddings', () => {
  let ws: TestWorkspace;
  let server: StubModelServer;
  let fixtures: FixturePaths;

  beforeEach(async () => {
    fixtures = fixturePaths(process.env['DATERA_FIXTURES'] as string);
    server = await startStubModelServer();
    ws = await openTestWorkspace({ ports: testPorts({ http: true }) });
    await ws.datera.addSource({ type: 'file', path: fixtures.ordersCsv, name: 'orders' });

    await ws.datera.setChatModel({
      tier: 'detected', provider: 'openai-compatible', id: 'stub-chat',
      role: 'chat', locality: 'local', endpoint: server.url, label: 'stub',
    });
    // An embedding model *is* configured — otherwise this would pass for the wrong
    // reason, proving only that an unconfigured embedder cannot be called.
    await ws.datera.setEmbeddingModel({
      tier: 'detected', provider: 'openai-compatible', id: 'stub-embed',
      role: 'embedding', locality: 'local', endpoint: server.url, label: 'stub',
    });
  });

  afterEach(async () => {
    await ws.dispose();
    await server.close();
  });

  it('never calls the embedding endpoint', async () => {
    server.setReply('SELECT product, sum(revenue_cents) AS revenue FROM orders GROUP BY product');

    const answer = await ws.datera.ask(DEFAULT_DATASET_ID, 'total revenue by product');
    expect(answer.answerable).toBe(true);

    const embedded = server.requests.filter((r) => r.path.startsWith('/v1/embeddings'));
    expect(embedded, `${embedded.length} embedding call(s) on a structured question`).toEqual([]);
  });

  it('calls it on the semantic path, so the check above means something', async () => {
    // The control. Without it, "zero embedding calls" could be true because embedding is
    // broken rather than because the router avoided it.
    await ws.datera.addSource({ type: 'file', path: fixtures.notesNdjson, name: 'support_notes' });
    await ws.datera.buildEmbeddings(DEFAULT_DATASET_ID);

    expect(server.requests.some((r) => r.path.startsWith('/v1/embeddings'))).toBe(true);
  });
});

describe('§12.5 routing', () => {
  const textColumns = ['note'];

  describe('structured questions go to SQL, with no embeddings computed', () => {
    const structured = [
      'how many orders were there?',
      'total revenue by product',
      'top 5 products by revenue',
      'average order value last quarter',
      'count the refunded orders',
      'sum of revenue_cents grouped by product',
      'what is the maximum qty?',
    ];

    it.each(structured)('routes %o to structured', (question) => {
      const decision = routeQuestion(question, textColumns);
      expect(decision.route).toBe('structured');
      expect(decision.reason).toBeTruthy();
    });
  });

  describe('free-text meaning questions go to semantic', () => {
    const semantic = [
      'which orders complained about damage?',
      'what did customers say about shipping?',
      'find notes mentioning a cracked item',
      'anything similar to "box was crushed"?',
      'show me feedback about late delivery',
    ];

    it.each(semantic)('routes %o to semantic', (question) => {
      const decision = routeQuestion(question, textColumns);
      expect(decision.route).toBe('semantic');
    });
  });

  it('routes to structured when the dataset has no embeddable text at all', () => {
    // Nothing to search means the semantic path cannot answer, whatever the wording.
    const decision = routeQuestion('what did customers complain about?', []);
    expect(decision.route).toBe('structured');
    expect(decision.reason).toMatch(/no embedded text|no text/i);
  });

  it('explains itself in terms a person can evaluate', () => {
    const decision = routeQuestion('which orders complained about damage?', textColumns);
    expect(decision.reason).toMatch(/meaning|free.?text|semantic/i);
    expect(decision.signals.length).toBeGreaterThan(0);
  });

  it('is deterministic', () => {
    const a = routeQuestion('total revenue by product', textColumns);
    const b = routeQuestion('total revenue by product', textColumns);
    expect(b).toEqual(a);
  });
});

describe('the semantic path end to end', () => {
  let ws: TestWorkspace;
  let server: StubModelServer;
  let fixtures: FixturePaths;

  beforeEach(async () => {
    fixtures = fixturePaths(process.env['DATERA_FIXTURES'] as string);
    server = await startStubModelServer();
    ws = await openTestWorkspace({ ports: testPorts({ http: true }) });

    await ws.datera.addSource({ type: 'file', path: fixtures.notesNdjson, name: 'support_notes' });
    await ws.datera.setChatModel({
      tier: 'detected', provider: 'ollama', id: 'llama3.1:8b', role: 'chat',
      locality: 'local', endpoint: server.url, label: 'llama3.1:8b',
    });
    await ws.datera.setEmbeddingModel({
      tier: 'detected', provider: 'ollama', id: 'nomic-embed-text', role: 'embedding',
      locality: 'local', endpoint: server.url, label: 'nomic-embed-text',
    });
  });

  afterEach(async () => {
    await ws.dispose();
    await server.close();
  });

  it('embeds the text columns of a source', async () => {
    const result = await ws.datera.buildEmbeddings(DEFAULT_DATASET_ID);

    expect(result.chunksEmbedded).toBe(3);
    expect(result.columns).toContain('note');
    // The embedding call goes to the embeddings endpoint, not the chat endpoint.
    expect(server.requests.some((r) => r.path.includes('/v1/embeddings'))).toBe(true);
  });

  it('stores vectors so a second build does not re-embed unchanged text', async () => {
    await ws.datera.buildEmbeddings(DEFAULT_DATASET_ID);
    const before = server.requests.length;

    const second = await ws.datera.buildEmbeddings(DEFAULT_DATASET_ID);

    expect(second.chunksEmbedded).toBe(0);
    expect(second.chunksReused).toBe(3);
    expect(server.requests.length).toBe(before);
  });

  it('retrieves the closest chunks, with their similarity scores', async () => {
    await ws.datera.buildEmbeddings(DEFAULT_DATASET_ID);

    const hits = await ws.datera.semanticSearch(DEFAULT_DATASET_ID, 'damaged in transit', 2);

    expect(hits).toHaveLength(2);
    expect(hits[0]?.score).toBeGreaterThanOrEqual(hits[1]?.score ?? 0);
    expect(hits[0]?.source).toBe('support_notes');
    expect(hits[0]?.text.length).toBeGreaterThan(0);
  });

  it('sends only the retrieved chunks to the model, never the corpus', async () => {
    // The semantic analogue of §12.2. Retrieval exists so the model sees a handful of
    // records rather than everything — if the whole corpus went, retrieval would be
    // pointless and the privacy story would be worse than the structured path's.
    await ws.datera.buildEmbeddings(DEFAULT_DATASET_ID);

    server.setReply('Two orders mention damage: A-1042 and A-1108.');
    const answer = await ws.datera.ask(DEFAULT_DATASET_ID, 'which orders complained about damage?', {
      topK: 1,
    });

    expect(answer.trace.route).toBe('semantic');

    const chatCall = server.requests.filter((r) => r.path.includes('/v1/chat/completions')).at(-1);
    const sent = JSON.stringify(chatCall?.json ?? {});

    // One chunk was requested, so only one may appear.
    const mentioned = ['Item arrived cracked', 'Box crushed in transit', 'Requested a refund'].filter(
      (t) => sent.includes(t),
    );
    expect(mentioned).toHaveLength(1);
  });

  it('cites the records it matched', async () => {
    await ws.datera.buildEmbeddings(DEFAULT_DATASET_ID);
    server.setReply('Two orders mention damage.');

    const answer = await ws.datera.ask(DEFAULT_DATASET_ID, 'which orders mention damage?');

    expect(answer.answerable).toBe(true);
    expect(answer.citations.sources).toContain('support_notes');
    expect(answer.citations.rowCount).toBeGreaterThan(0);
  });

  it('records embed and retrieve stages in the trace, with scores', async () => {
    await ws.datera.buildEmbeddings(DEFAULT_DATASET_ID);
    server.setReply('An answer.');

    const answer = await ws.datera.ask(DEFAULT_DATASET_ID, 'what did people complain about?');

    const kinds = answer.trace.stages.map((s) => s.kind);
    expect(kinds).toContain('embed');
    expect(kinds).toContain('retrieve');
    expect(kinds).not.toContain('sql');

    const retrieve = answer.trace.stages.find((s) => s.kind === 'retrieve');
    expect(retrieve?.detail).toMatch(/0\.\d+/);
  });

  it('names the embedding model separately from the chat model (§1.6)', async () => {
    await ws.datera.buildEmbeddings(DEFAULT_DATASET_ID);
    server.setReply('An answer.');

    const answer = await ws.datera.ask(DEFAULT_DATASET_ID, 'what did people complain about?');

    const embed = answer.trace.stages.find((s) => s.kind === 'embed');
    expect(embed?.modelName).toContain('nomic-embed-text');

    const chat = answer.trace.stages.find((s) => s.kind === 'model');
    expect(chat?.modelName).toContain('llama3.1:8b');
  });

  it('says so plainly when nothing has been embedded yet', async () => {
    server.setReply('An answer.');
    const answer = await ws.datera.ask(DEFAULT_DATASET_ID, 'what did people complain about?');

    expect(answer.answerable).toBe(false);
    expect(answer.flag).toMatch(/embed/i);
  });

  it('keeps embeddings out of other datasets', async () => {
    await ws.datera.buildEmbeddings(DEFAULT_DATASET_ID);
    await ws.datera.createDataset({ id: 'other', name: 'Other' });

    const hits = await ws.datera.semanticSearch('other', 'damage', 5);
    expect(hits).toEqual([]);
  });

  it('survives a restart', async () => {
    await ws.datera.buildEmbeddings(DEFAULT_DATASET_ID);
    ws = await ws.reopen();

    const hits = await ws.datera.semanticSearch(DEFAULT_DATASET_ID, 'damage', 2);
    expect(hits.length).toBeGreaterThan(0);
  });
});

describe('§1.6 embeddings default to local', () => {
  let ws: TestWorkspace;

  afterEach(async () => {
    await ws?.dispose();
  });

  it('does not fall back to a remote embedder when chat is remote', async () => {
    const server = await startStubModelServer();
    try {
      ws = await openTestWorkspace({ ports: testPorts({ http: true }) });
      await ws.datera.setApiKey('anthropic', 'sk-ant-test-key-123456');
      await ws.datera.setChatModel({
        tier: 'remote', provider: 'anthropic', id: 'claude-sonnet-4-5', role: 'chat',
        locality: 'remote', label: 'claude-sonnet-4-5',
      });

      // Choosing a remote chat model must not silently select a remote embedder —
      // that would send the *text itself* to a third party, which the structured path
      // never does.
      const catalogue = await ws.datera.listModels();
      expect(catalogue.selectedEmbedding).toBeNull();
    } finally {
      await server.close();
    }
  });
});
