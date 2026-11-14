/** Optional operational correlation; never used for authentication or metric labels. */
export class WorkerContext {
  private constructor(readonly trace: string) { Object.freeze(this); }
  static fromHeaders(project: string | undefined, traceparent?: string, cloudTrace?: string): WorkerContext | undefined {
    if (!project || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project)) return;
    const parent = traceparent === undefined ? undefined : /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/.exec(traceparent);
    const legacy = cloudTrace === undefined ? undefined : /^([0-9a-f]{32})\/([0-9]{1,20})(?:;o=[01])?$/.exec(cloudTrace);
    if (traceparent !== undefined && (!parent || /^0+$/.test(parent[1]!) || /^0+$/.test(parent[2]!))) return;
    if (cloudTrace !== undefined && (!legacy || /^0+$/.test(legacy[1]!) || BigInt(legacy[2]!) === 0n || BigInt(legacy[2]!) > 0xffffffffffffffffn)) return;
    if (parent && legacy && (parent[1] !== legacy[1] || BigInt('0x' + parent[2]!) !== BigInt(legacy[2]!))) return;
    const id = parent?.[1] ?? legacy?.[1];
    return id ? new WorkerContext(`projects/${project}/traces/${id}`) : undefined;
  }
}
