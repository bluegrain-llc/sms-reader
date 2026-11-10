#!/usr/bin/env node
// Staging-only REST workload. No credentials, form values, or response bodies enter output.
import { setMaxListeners } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs, promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { WorkloadState, StreamObservation, workloadComplete, streamLifetime } from './capacity-observation.mjs';

const { values } = parseArgs({ options: { config: { type: 'string' }, output: { type: 'string' }, quick: { type: 'boolean', default: false } } });
const state = new WorkloadState(), unwatch = state.watch(process);
setMaxListeners(256, state.abort.signal);
const sleep = ms => new Promise(resolve => {
  const done = () => { clearTimeout(timer); state.abort.signal.removeEventListener('abort', done); resolve(); };
  const timer = setTimeout(done, ms);
  state.abort.signal.addEventListener('abort', done, { once: true }); if (state.abort.signal.aborted) done();
});
try {
  const c = JSON.parse(await readFile(values.config, 'utf8')), url = new URL(c.baseUrl);
  if (url.protocol !== 'https:' || c.environment !== 'staging' || c.project === c.productionProject || !c.project || !c.productionProject
    || !Array.isArray(c.callers) || c.callers.length !== 200 || new Set(c.callers.map(x => x.owner)).size !== 100
    || c.callers.some(x => !/^smsr_[A-Za-z0-9_-]{43}$/.test(x.token))) throw Error('invalid staging fixture');
  if (!/^[a-z][a-z0-9-]*$/.test(c.service ?? '') || !/^[a-z][a-z0-9-]*$/.test(c.region ?? '')) throw Error('invalid service');
  const verified = JSON.parse((await promisify(execFile)('gcloud', ['run', 'services', 'describe', c.service, '--project=' + c.project,
    '--region=' + c.region, '--format=json'], { timeout: 15000 })).stdout);
  if (verified.status?.url !== url.origin || verified.metadata?.labels?.environment !== 'staging') throw Error('unverified staging service');
  const health = await fetch(new URL('/health', url), { signal: AbortSignal.timeout(10000) });
  await health.body?.cancel(); if (!health.ok) throw Error('staging unavailable');
  const started = Date.now(), duration = values.quick ? 60000 : 86400000, requests = values.quick ? 20 : 10000;
  const peakDuration = values.quick ? 30000 : 1800000;
  const observation = new StreamObservation(started, duration, peakDuration);
  const metrics = { requestOk: 0, requestFailed: 0, cancelOk: 0, streamConnections: 0, streamFailures: 0,
    eventFrames: 0, latencyMs: [], streamSeconds: 0 };
  async function request(caller, path, body) {
    const t = performance.now();
    try {
      const response = await fetch(new URL(path, url), { method: 'POST', headers: { Authorization: `Bearer ${caller.token}`,
        'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.any([state.abort.signal, AbortSignal.timeout(15000)]) });
      metrics.latencyMs.push(performance.now() - t);
      if (!response.ok) { await response.body?.cancel(); throw Error('request rejected'); }
      return await response.json();
    } catch { return null; }
  }
  async function stream(caller, index) {
    const plannedEnd = started + streamLifetime(index, duration, peakDuration, values.quick);
    while (state.running && Date.now() < plannedEnd) {
      const local = new AbortController(); let openedAt, reader, cleanEof = false;
      const timeout = setTimeout(() => local.abort(), Math.min(110000, Math.max(1, plannedEnd - Date.now())));
      const stop = () => local.abort(); state.abort.signal.addEventListener('abort', stop, { once: true });
      try {
        const response = await fetch(new URL('/v2/events/stream', url), { headers: { Authorization: `Bearer ${caller.token}` }, signal: local.signal });
        if (!response.ok || !response.headers.get('content-type')?.startsWith('text/event-stream') || !response.body) {
          await response.body?.cancel(); throw Error('stream rejected');
        }
        openedAt = observation.open(Date.now()); metrics.streamConnections++; reader = response.body.getReader();
        const decoder = new TextDecoder();
        while (state.running && Date.now() < plannedEnd) {
          const chunk = await reader.read(); if (chunk.done) { cleanEof = true; break; }
          metrics.eventFrames += (decoder.decode(chunk.value, { stream: true }).match(/^id:/gm) ?? []).length;
        }
      } catch { if (state.running && Date.now() < plannedEnd) metrics.streamFailures++; }
      finally {
        local.abort(); clearTimeout(timeout); state.abort.signal.removeEventListener('abort', stop); reader?.releaseLock();
        if (openedAt !== undefined) { const ended = Date.now(); observation.close(openedAt, ended, plannedEnd, cleanEof); metrics.streamSeconds += (ended - openedAt) / 1000; }
      }
      if (state.running && Date.now() < plannedEnd) await sleep(250 + Math.random() * 750);
    }
  }
  const streams = c.callers.map(stream);
  for (let i = 0; i < requests && state.running; i++) {
    await sleep(Math.max(0, started + i * duration / requests - Date.now())); if (!state.running) break;
    const caller = c.callers[i % c.callers.length];
    const result = await request(caller, '/v2/requests', { title: 'Synthetic capacity request', body: 'Synthetic capacity fixture', fields: [],
      actions: [{ id: 'ack', label: 'Acknowledge', type: 'acknowledge' }], idempotencyKey: `capacity-${started}-${i}`, expiresInSeconds: 60 });
    if (result?.requestId) {
      metrics.requestOk++; const cancelled = await request(caller, `/v2/requests/${result.requestId}/cancel`, {});
      if (cancelled?.status === 'cancelled') metrics.cancelOk++;
    } else metrics.requestFailed++;
  }
  await sleep(Math.max(0, started + duration - Date.now())); state.stop(); await Promise.allSettled(streams);
  const completedAt = Date.now(), observed = observation.result(completedAt);
  unwatch();
  const samples = metrics.latencyMs.sort((a, b) => a - b); delete metrics.latencyMs;
  const complete = workloadComplete({ state, startedAt: started, duration, completedAt, expectedRequests: requests, metrics, observed });
  const report = { version: 1, kind: values.quick ? 'smoke' : '24h', project: c.project, startedAt: started, completedAt,
    interrupted: state.interrupted, loadGenerationComplete: complete, ...metrics, ...observed,
    p95Ms: samples[Math.floor(samples.length * .95)] ?? null, expectedRequests: requests,
    physicalDeliveryProven: false, costProven: false, streamProfileProven: false };
  await writeFile(values.output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  if (!complete) process.exitCode = 1;
  console.log(JSON.stringify({ report: values.output, requests: report.requestOk, failures: report.requestFailed, complete }));
} catch { console.error('capacity_run_failed'); process.exitCode = 1; }
finally { state.stop(); unwatch(); }
