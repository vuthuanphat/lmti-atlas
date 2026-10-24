import { spawn } from 'node:child_process';
import { ApiError, requireThat, strictJson, type Code } from './security.js';

export type WriteResult =
  | {kind: 'not_started'; code: Code}
  | {kind: 'closed'; exitCode: number|null; bytes: Buffer|null; transportOk: boolean};
interface AdmissionOptions {
  // Applies only before a child starts. Dispatched writes retain their close-only lifetime.
  queueTimeoutMs?: number;
  signal?: AbortSignal;
}
export interface WriteOptions extends AdmissionOptions {
  cap?: number;
  guard?: () => void|Promise<void>;
  // Notification only, not permission to dispatch. Throwing cannot cancel a child.
  onStarted?: () => void;
}
// A dispatched legacy writer closed without a reliable decoded reply.
// The caller must inspect owner state; this is not evidence of a refused write.
export class WriteOutcomeUnknown extends ApiError {
  constructor() { super('RECOVERY_REQUIRED'); }
}
interface RunOptions extends AdmissionOptions {
  write?: boolean; cap?: number; raw?: boolean; timeoutMs?: number;
  newlineTerminated?: boolean;
  jsonArrayLimit?: 2000|4000|16000;
  guard?: () => void|Promise<void>; projectProposalErrors?: boolean;
}
function environment(): Record<string,string> {
  const env: Record<string,string> = {PYTHONIOENCODING:'utf-8'};
  for (const key of ['SystemRoot','WINDIR']) if (process.env[key]) env[key] = process.env[key]!;
  return env;
}
function decode(bytes: Buffer, code: number|null, options: RunOptions): unknown {
  requireThat(code === 0 || (code === 1 && options.projectProposalErrors),'OWNER_UNAVAILABLE');
  try {
    // Private owner dictionaries may use valid keys such as constructor.
    const value = options.raw ? bytes.toString('utf8') : strictJson(bytes,false,options.jsonArrayLimit);
    if (code !== 0) {
      const error = value as {ok?: unknown; error?: {code?: unknown}};
      requireThat(!options.raw && error && typeof error === 'object' &&
        Object.keys(error).length === 2 && error.ok === false && error.error &&
        typeof error.error === 'object' && Object.keys(error.error).length === 1 &&
        ['INVALID_INPUT','SCOPE_DENIED','REVISION_CONFLICT','CONFIG_CONFLICT','OWNER_UNAVAILABLE'].includes(String(error.error.code)),'OWNER_UNAVAILABLE');
    }
    return value;
  } catch { throw new ApiError('OWNER_UNAVAILABLE'); }
}

export class ProcessPool {
  private active = 0;
  private waiting: { admit: () => boolean }[] = [];
  private idleWaiters: (() => void)[] = [];
  // Optional injection supports lifecycle tests with real child processes.
  // Production callers retain the fixed Node spawn implementation.
  constructor(private readonly capacity = 2, private readonly spawnChild: typeof spawn = spawn) {
    requireThat(Number.isInteger(capacity) && capacity >= 1 && capacity <= 2);
  }
  isIdle(): boolean { return this.active === 0 && this.waiting.length === 0; }
  // The caller must stop admitting work before using this as a shutdown drain.
  waitForIdle(): Promise<void> {
    return this.isIdle() ? Promise.resolve() : new Promise((resolve) => this.idleWaiters.push(resolve));
  }
  private async acquire(options: AdmissionOptions) {
    const timeout = options.queueTimeoutMs ?? 30000;
    requireThat(Number.isSafeInteger(timeout) && timeout >= 1 && timeout <= 120000);
    requireThat(!options.signal?.aborted,'SESSION_EXPIRED');
    if (this.active >= this.capacity) {
      requireThat(this.waiting.length < 16,'BUSY');
      const deadline = performance.now()+timeout;
      await new Promise<void>((resolve,reject) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout>;
        const cleanup = () => {
          clearTimeout(timer);
          options.signal?.removeEventListener('abort',abort);
        };
        const refuse = (code: Code) => {
          if (settled) return;
          settled = true;
          const index = this.waiting.indexOf(waiter);
          if (index >= 0) this.waiting.splice(index,1);
          cleanup(); reject(new ApiError(code));
        };
        const abort = () => refuse('SESSION_EXPIRED');
        const waiter = {admit: () => {
          if (settled) return false;
          if (options.signal?.aborted) { abort(); return false; }
          // A busy event loop must not admit an expired entry before its timer runs.
          if (performance.now() >= deadline) { refuse('BUSY'); return false; }
          settled = true; cleanup(); resolve(); return true;
        }};
        this.waiting.push(waiter);
        timer = setTimeout(() => refuse('BUSY'),timeout);
        options.signal?.addEventListener('abort',abort,{once:true});
        if (options.signal?.aborted) abort();
      });
    } else this.active++;
  }
  private release() {
    let admitted = false;
    while (this.waiting.length && !admitted) admitted = this.waiting.shift()!.admit();
    if (!admitted) this.active--;
    if (this.isIdle()) {
      const completed = this.idleWaiters.splice(0);
      for (const resolve of completed) resolve();
    }
  }
  async runWrite(binary: string, args: string[], input: string, options: WriteOptions = {}): Promise<WriteResult> {
    const cap = options.cap ?? 512*1024;
    try {
      requireThat(Buffer.byteLength(input) <= 128*1024,'LIMIT_EXCEEDED');
      requireThat(Number.isSafeInteger(cap) && cap >= 1 && cap <= 4*1024*1024);
      await this.acquire(options);
    } catch (e) {
      return {kind:'not_started',code:e instanceof ApiError ? e.code : 'OWNER_UNAVAILABLE'};
    }
    try {
      try {
        requireThat(!options.signal?.aborted,'SESSION_EXPIRED');
        await options.guard?.();
        requireThat(!options.signal?.aborted,'SESSION_EXPIRED');
      }
      catch (e) { return {kind:'not_started',code:e instanceof ApiError ? e.code : 'OWNER_UNAVAILABLE'}; }
      return await new Promise<WriteResult>((resolve) => {
        const launch = () => this.spawnChild(binary,args,{
          shell:false,windowsHide:true,env:environment(),stdio:['pipe','pipe','ignore']
        });
        let child: ReturnType<typeof launch>;
        try { child = launch(); }
        catch { resolve({kind:'not_started',code:'OWNER_UNAVAILABLE'}); return; }
        // PID evidence is retained even if an error arrives before 'spawn'.
        // An error event alone never proves a running writer did not start.
        const hasPid = () => Number.isInteger(child.pid) && child.pid! > 0;
        let started = hasPid(), notified = false, errorSeen = false, failed = false;
        let total = 0, overflow = false;
        const chunks: Buffer[] = [];
        const notifyStarted = () => {
          started = true;
          if (notified) return;
          notified = true;
          try { options.onStarted?.(); } catch { failed = true; }
        };
        child.once('spawn',notifyStarted);
        child.on('error',() => {
          errorSeen = true; failed = true;
          if (hasPid() || started) notifyStarted();
          // Even a genuine no-start error waits for close before releasing its slot.
        });
        child.stdout.on('data',(chunk: Buffer) => {
          if (overflow) return; // Keep draining; retain no excess output.
          if (chunk.length > cap-total) {
            overflow = true; failed = true; chunks.length = 0;
          } else { total += chunk.length; chunks.push(chunk); }
        });
        child.stdout.on('error',() => { failed = true; });
        child.stdin.on('error',() => { failed = true; });
        child.once('close',(exitCode) => {
          if (hasPid() || started) notifyStarted();
          if (!started && errorSeen) {
            resolve({kind:'not_started',code:'OWNER_UNAVAILABLE'}); return;
          }
          // Nonzero exit remains available to the legacy typed proposal decoder.
          // transportOk describes complete transport, not owner confirmation.
          let bytes: Buffer|null = null;
          let transportOk = started && !failed && exitCode !== null;
          if (transportOk) {
            try { bytes = Buffer.concat(chunks,total); }
            catch { transportOk = false; }
          }
          resolve({kind:'closed',exitCode,bytes,transportOk});
        });
        try { child.stdin.end(input); }
        catch {
          failed = true;
          // Close only our input pipe, never terminate a dispatched writer.
          child.stdin.destroy();
        }
      });
    } finally { this.release(); }
  }
  async run(binary: string, args: string[], input: string, options: RunOptions = {}): Promise<unknown> {
    requireThat(Buffer.byteLength(input) <= 128*1024,'LIMIT_EXCEEDED');
    if (options.write) {
      requireThat(!options.raw);
      const result = await this.runWrite(binary,args,input,{cap:options.cap ?? 4*1024*1024,guard:options.guard,
        queueTimeoutMs:options.queueTimeoutMs,signal:options.signal});
      if (result.kind === 'not_started') throw new ApiError(result.code);
      if (!result.transportOk || result.bytes === null) throw new WriteOutcomeUnknown();
      try { return decode(result.bytes,result.exitCode,options); }
      catch { throw new WriteOutcomeUnknown(); }
    }
    await this.acquire(options);
    try {
      requireThat(!options.signal?.aborted,'SESSION_EXPIRED');
      await options.guard?.();
      requireThat(!options.signal?.aborted,'SESSION_EXPIRED');
      return await new Promise((resolve,reject) => {
        const child = this.spawnChild(binary,args,{shell:false,windowsHide:true,env:environment(),stdio:['pipe','pipe','ignore']});
        const chunks: Buffer[] = []; let total = 0, failed = false;
        const cap = options.cap ?? 4*1024*1024;
        const timer = setTimeout(() => { failed = true; child.kill(); },options.timeoutMs ?? 10000);
        child.stdout.on('data',(b: Buffer) => {
          total += b.length;
          if (total <= cap) chunks.push(b);
          else { failed = true; child.kill(); }
        });
        child.stdin.on('error',() => { failed = true; });
        child.once('error',() => { if (timer) clearTimeout(timer); reject(new ApiError('OWNER_UNAVAILABLE')); });
        child.once('close',(code) => {
          if (timer) clearTimeout(timer);
          if (failed || (code !== 0 && !(code === 1 && options.projectProposalErrors))) { reject(new ApiError('OWNER_UNAVAILABLE')); return; }
          try {
            const bytes = Buffer.concat(chunks);
            requireThat(!options.newlineTerminated || (bytes.length > 0 && bytes[bytes.length-1] === 10),'OWNER_UNAVAILABLE');
            resolve(decode(bytes,code,options));
          }
          catch { reject(new ApiError('OWNER_UNAVAILABLE')); }
        });
        child.stdin.end(input);
      });
    } finally { this.release(); }
  }
}
