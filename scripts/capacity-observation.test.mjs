import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { WorkloadState, StreamObservation, workloadComplete, streamLifetime } from './capacity-observation.mjs';

const duration = 86400_000;
const metrics = () => ({ requestOk: 10000, cancelOk: 10000, requestFailed: 0, streamFailures: 0, eventFrames: 1 });
const observed = { prematureStreamEnds: 0, observedMaxConcurrentStreams: 200 };
test('HTTP streams that immediately end cannot complete a successful request workload', () => {
  const streams = new StreamObservation(0, duration, 1800_000);
  const opened = Array.from({ length: 200 }, () => streams.open(0));
  for (const time of opened) streams.close(time, 1, duration, true);
  const result = streams.result(duration);
  assert.equal(result.observedMaxConcurrentStreams, 200); assert.equal(result.prematureStreamEnds, 200);
  assert.equal(workloadComplete({ state: new WorkloadState(), startedAt: 0, duration, completedAt: duration,
    expectedRequests: 10000, metrics: metrics(), observed: result }), false);
});
test('normal lifetime EOF and planned phase shutdown preserve observed concurrency accounting', () => {
  const streams = new StreamObservation(0, duration, 1800_000);
  const first = streams.open(0), second = streams.open(10_000);
  streams.close(first, 100_000, duration, true);
  streams.close(second, 120_000, 120_000, false);
  const result = streams.result(120_000);
  assert.equal(result.prematureStreamEnds, 0); assert.equal(result.observedMaxConcurrentStreams, 2);
  assert.equal(result.observedAverageStreams, 210_000 / 120_000);
});
test('late SIGINT or SIGTERM prevents success after the final request counters are complete', () => {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const state = new WorkloadState(), emitter = new EventEmitter(), cleanup = state.watch(emitter);
    try {
      emitter.emit(signal); assert.equal(state.running, false); assert.equal(state.abort.signal.aborted, true);
      assert.equal(workloadComplete({ state, startedAt: 0, duration, completedAt: duration + 1,
        expectedRequests: 10000, metrics: metrics(), observed }), false);
    } finally { cleanup(); state.stop(); }
  }
});
test('final waiting interval is required even after all requests and stream counters succeed', () => {
  const input = { state: new WorkloadState(), startedAt: 0, duration, expectedRequests: 10000, metrics: metrics(), observed };
  assert.equal(workloadComplete({ ...input, completedAt: duration - 1 }), false);
  assert.equal(workloadComplete({ ...input, completedAt: duration }), true);
});
test('full-day configured stream profile includes the peak within twenty average streams', () => {
  const lifetimes = Array.from({ length: 200 }, (_, index) => streamLifetime(index, duration, 1800_000, false));
  assert.equal(lifetimes.reduce((sum, value) => sum + value, 0) / duration, 20);
  assert.equal(lifetimes.filter(value => value >= 1800_000).length, 200);
});
