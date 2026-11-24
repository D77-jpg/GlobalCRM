import { createHash } from 'node:crypto';
import { currentOrganizationId } from '../../models/tenant-context';
import { AgentProviderError } from './provider';

type Circuit = {
  failures: number;
  rateLimits: number;
  openedAt: number;
  active: number;
  lastUsed: number;
  probe: boolean;
};

const MAX_GLOBAL_CONCURRENT = Math.max(4, Math.min(24, Number(process.env.AI_MAX_CONCURRENT || 8)));
const MAX_TENANT_CONCURRENT = Math.max(2, Math.min(8, Number(process.env.AI_MAX_TENANT_CONCURRENT || 4)));
const MAX_QUEUE_SIZE = 24;
const QUEUE_WAIT_MS = 12_000;
const COOLDOWN_MS = 30_000;

const circuits = new Map<string, Circuit>();
const tenantActive = new Map<string, number>();
const waitQueue: Array<{ tenantKey: string; grant: () => void; reject: (err: Error) => void }> = [];

const metrics = {
  requests: 0,
  failed: 0,
  rateLimited: 0,
  retried: 0,
  queued: 0,
  rejected: 0,
  inputTokens: 0,
  outputTokens: 0,
  unknownUsage: 0,
  totalMs: 0,
  maxMs: 0,
};

function totalActive(): number {
  let n = 0;
  for (const c of circuits.values()) n += c.active;
  return n;
}

function canAcquire(tenantKey: string): boolean {
  return totalActive() < MAX_GLOBAL_CONCURRENT && (tenantActive.get(tenantKey) ?? 0) < MAX_TENANT_CONCURRENT;
}

function drainQueue(): void {
  for (let i = 0; i < waitQueue.length; ) {
    const waiter = waitQueue[i];
    if (canAcquire(waiter.tenantKey)) {
      waitQueue.splice(i, 1);
      waiter.grant();
      continue;
    }
    i++;
  }
}

async function acquireSlot(tenantKey: string): Promise<void> {
  if (canAcquire(tenantKey)) {
    tenantActive.set(tenantKey, (tenantActive.get(tenantKey) ?? 0) + 1);
    return;
  }
  if (waitQueue.length >= MAX_QUEUE_SIZE) {
    metrics.rejected++;
    throw new AgentProviderError('OPENAI_CAPACITY');
  }
  metrics.queued++;
  await new Promise<void>((resolve, reject) => {
    const entry = {
      tenantKey,
      grant: () => {
        clearTimeout(timer);
        tenantActive.set(tenantKey, (tenantActive.get(tenantKey) ?? 0) + 1);
        resolve();
      },
      reject: (err: Error) => {
        clearTimeout(timer);
        reject(err);
      },
    };
    const timer = setTimeout(() => {
      const idx = waitQueue.indexOf(entry);
      if (idx >= 0) waitQueue.splice(idx, 1);
      metrics.rejected++;
      reject(new AgentProviderError('OPENAI_CAPACITY'));
    }, QUEUE_WAIT_MS);
    timer.unref();
    waitQueue.push(entry);
  });
}

function releaseSlot(tenantKey: string): void {
  const cur = (tenantActive.get(tenantKey) ?? 1) - 1;
  if (cur <= 0) tenantActive.delete(tenantKey);
  else tenantActive.set(tenantKey, cur);
  drainQueue();
}

export function modelCircuitState(): { open: boolean; openCount: number; cooldownRemainingMs: number } {
  const now = Date.now();
  let openCount = 0;
  let cooldownRemainingMs = 0;
  for (const c of circuits.values()) {
    if (!c.openedAt) continue;
    const elapsed = now - c.openedAt;
    if (elapsed < COOLDOWN_MS) {
      openCount++;
      cooldownRemainingMs = Math.max(cooldownRemainingMs, COOLDOWN_MS - elapsed);
    } else if (c.probe) {
      openCount++;
      cooldownRemainingMs = Math.max(cooldownRemainingMs, 2000);
    }
  }
  return { open: openCount > 0, openCount, cooldownRemainingMs };
}

export function resetModelCircuitsForTest(): void {
  if (process.env.NODE_ENV === 'test' || process.env.NODE_TEST_CONTEXT) {
    circuits.clear();
  }
}

export function modelTransportStatus() {
  const circuit = modelCircuitState();
  return {
    ...metrics,
    active: totalActive(),
    queueLength: waitQueue.length,
    openCircuits: circuit.openCount,
    cooldownRemainingMs: circuit.cooldownRemainingMs,
    cooldownMs: COOLDOWN_MS,
    maxConcurrent: MAX_GLOBAL_CONCURRENT,
    maxPerTenant: MAX_TENANT_CONCURRENT,
    cost: 'See project quota estimates; transport failures may incur unreported vendor cost',
  };
}

function retryDelayMs(response: Response, attempt: number): number {
  const header = response.headers.get('retry-after')?.trim();
  if (header) {
    if (/^\d+$/.test(header)) return Math.min(8000, Math.max(300, Number(header) * 1000));
    const parsed = Date.parse(header);
    if (Number.isFinite(parsed)) return Math.min(8000, Math.max(300, parsed - Date.now()));
  }
  return Math.min(4000, (attempt + 1) * 700 + Math.floor(Math.random() * 250));
}

const sleep = (ms: number) => new Promise<void>((resolve) => {
  const t = setTimeout(resolve, ms);
  t.unref();
});

export async function guardedModelFetch(url: string, init: RequestInit): Promise<Response> {
  const originHost = (() => { try { return new URL(url).origin; } catch { return url; } })();
  // Key circuit per endpoint URL + headers (so one failing path cannot trip unrelated endpoints),
  // while scheduling concurrency per tenant + provider origin.
  const key = createHash('sha256').update(url + JSON.stringify(init.headers)).digest('hex');
  const tenantKey = `${String(currentOrganizationId() ?? 'global')}:${originHost}`;
  const now = Date.now();

  if (!circuits.has(key) && circuits.size >= 64) {
    for (const [k, c] of circuits) if (!c.active && now - c.lastUsed > COOLDOWN_MS) circuits.delete(k);
    if (circuits.size >= 64) {
      metrics.rejected++;
      throw new AgentProviderError('OPENAI_CAPACITY');
    }
  }

  const c = circuits.get(key) ?? { failures: 0, rateLimits: 0, openedAt: 0, active: 0, lastUsed: now, probe: false };
  circuits.set(key, c);
  c.lastUsed = now;

  if (c.openedAt && (now - c.openedAt < COOLDOWN_MS || c.probe)) {
    metrics.rejected++;
    throw new AgentProviderError('OPENAI_CIRCUIT_OPEN');
  }

  await acquireSlot(tenantKey);
  if (c.openedAt) c.probe = true;
  c.active++;
  metrics.requests++;

  let serviceFault = false;
  let usageKnown = false;
  try {
    let response!: Response;
    for (let attempt = 0; attempt < 2; attempt++) {
      response = await fetch(url, init);
      // Differentiate 429 rate-limit from 5xx service outage:
      // retry 429 once with Retry-After/jitter without tripping the 5xx circuit breaker.
      // Never implicitly retry 5xx faults — durable workflow owns bounded fault retries (S7 contract).
      if (response.status === 429 && attempt === 0) {
        metrics.rateLimited++;
        metrics.retried++;
        await response.body?.cancel().catch(() => undefined);
        await sleep(retryDelayMs(response, attempt));
        continue;
      }
      break;
    }

    if (Number(response.headers.get('content-length') ?? 0) > 4 * 1024 ** 2) {
      await response.body?.cancel();
      throw new AgentProviderError('OPENAI_RESPONSE_LIMIT');
    }

    const reader = response.body?.getReader();
    let size = 0;
    const parts: Uint8Array[] = [];
    if (reader) {
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.length;
          if (size > 4 * 1024 ** 2) throw new AgentProviderError('OPENAI_RESPONSE_LIMIT');
          parts.push(part.value);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
    }

    const text = Buffer.concat(parts).toString('utf8');
    let parsed: {
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        prompt_tokens?: number;
        completion_tokens?: number;
      };
      status?: string;
    };

    try {
      parsed = JSON.parse(text);
    } catch {
      if (!response.ok) {
        // 404/405 protocol fallback probe (e.g. /responses -> /chat/completions) is NOT a service outage!
        if (response.status >= 500) serviceFault = true;
        if (response.status === 429) { metrics.rateLimited++; c.rateLimits++; }
        return new Response(text, { status: response.status, headers: { 'content-type': 'text/plain' } });
      }
      throw new AgentProviderError('OPENAI_INVALID_RESPONSE');
    }

    if (parsed.usage) {
      // Support BOTH OpenAI Responses API (`input_tokens`/`output_tokens`) AND Chat Completions (`prompt_tokens`/`completion_tokens`)
      const inputTokens = parsed.usage.input_tokens ?? parsed.usage.prompt_tokens;
      const outputTokens = parsed.usage.output_tokens ?? parsed.usage.completion_tokens;
      if (Number.isSafeInteger(inputTokens) && inputTokens! >= 0 && Number.isSafeInteger(outputTokens) && outputTokens! >= 0) {
        metrics.inputTokens += inputTokens!;
        metrics.outputTokens += outputTokens!;
        usageKnown = true;
      }
    }

    if (response.status === 429) {
      metrics.rateLimited++;
      c.rateLimits++;
    } else if (response.status >= 500 || parsed.status === 'failed') {
      serviceFault = true;
    } else if (response.ok) {
      c.failures = 0;
      c.openedAt = 0;
    }
    return new Response(text, { status: response.status, headers: { 'content-type': 'application/json' } });
  } catch (e) {
    serviceFault = true;
    throw e;
  } finally {
    if (!usageKnown) metrics.unknownUsage++;
    if (serviceFault) {
      metrics.failed++;
      if (++c.failures >= 3) c.openedAt = Date.now();
    }
    c.active--;
    c.probe = false;
    releaseSlot(tenantKey);
    const elapsed = Date.now() - now;
    metrics.totalMs += elapsed;
    metrics.maxMs = Math.max(metrics.maxMs, elapsed);
  }
}
