export class WorkloadState {
  running = true;
  interrupted = false;
  abort = new AbortController();
  watch(emitter) {
    const interrupt = () => { this.interrupted = true; this.stop(); };
    emitter.on('SIGINT', interrupt); emitter.on('SIGTERM', interrupt);
    return () => { emitter.removeListener('SIGINT', interrupt); emitter.removeListener('SIGTERM', interrupt); };
  }
  stop() { this.running = false; this.abort.abort(); }
}

export class StreamObservation {
  active = 0;
  maximum = 0;
  prematureEnds = 0;
  area = 0;
  peakArea = 0;
  atTargetMs = 0;
  constructor(startedAt, duration, peakDuration) {
    this.startedAt = startedAt; this.endAt = startedAt + duration;
    this.peakEndAt = startedAt + peakDuration; this.lastAt = startedAt;
  }
  advance(now) {
    const until = Math.max(this.lastAt, Math.min(now, this.endAt));
    this.area += this.active * (until - this.lastAt);
    const peakElapsed = Math.max(0, Math.min(until, this.peakEndAt) - Math.min(this.lastAt, this.peakEndAt));
    this.peakArea += this.active * peakElapsed;
    if (this.active === 200) this.atTargetMs += peakElapsed;
    this.lastAt = until;
  }
  open(now) { this.advance(now); this.active++; this.maximum = Math.max(this.maximum, this.active); return now; }
  close(openedAt, now, plannedEnd, cleanEof) {
    this.advance(now); this.active--;
    // The service normally reconnects at 100 seconds; permit watch startup time.
    if (cleanEof && now < plannedEnd && now - openedAt < Math.min(85_000, plannedEnd - openedAt)) this.prematureEnds++;
  }
  result(now) {
    this.advance(now);
    return { observedMaxConcurrentStreams: this.maximum, prematureStreamEnds: this.prematureEnds,
      observedAverageStreams: this.area / Math.max(1, this.lastAt - this.startedAt),
      observedPeakAverageStreams: this.peakArea / Math.max(1, Math.min(this.lastAt, this.peakEndAt) - this.startedAt),
      observedPeakSecondsAtTarget: this.atTargetMs / 1000 };
  }
}

export function workloadComplete({ state, startedAt, duration, completedAt, expectedRequests, metrics, observed }) {
  return !state.interrupted && completedAt - startedAt >= duration
    && metrics.requestOk === expectedRequests && metrics.cancelOk === expectedRequests
    && metrics.requestFailed === 0 && metrics.streamFailures === 0 && metrics.eventFrames > 0
    && observed.prematureStreamEnds === 0 && observed.observedMaxConcurrentStreams === 200;
}

export function streamLifetime(index, duration, peakDuration, smoke) {
  if (smoke) return index < 20 ? duration : peakDuration;
  // 200 for half an hour, 17 for four hours, then 16: 480 stream-hours/day.
  return index < 16 ? duration : index === 16 ? peakDuration + 4 * 3600_000 : peakDuration;
}

// Keep only field prefixes and frame state; arbitrary data lines never accumulate.
export class SseEventCounter {
  prefix = '';
  length = 0;
  afterCr = false;
  hasId = false;
  push(text) {
    let frames = 0;
    const line = () => {
      if (this.length === 0) { if (this.hasId) frames++; this.hasId = false; }
      else if (this.prefix === 'id:' || (this.length === 2 && this.prefix === 'id')) this.hasId = true;
      this.prefix = ''; this.length = 0;
    };
    for (const char of text) {
      if (char === '\r') { line(); this.afterCr = true; }
      else if (char === '\n') { if (!this.afterCr) line(); this.afterCr = false; }
      else {
        this.afterCr = false;
        if (this.length < 3) this.prefix += char;
        this.length = Math.min(4, this.length + 1);
      }
    }
    return frames;
  }
}
