import type { TaskProgress } from './task-progress.ts';
import { MAX_INTERMEDIATE_MESSAGES, intermediateContent } from './reply-budget.ts';
import type { BotReply } from './reply-types.ts';
import { drawingPrompt } from './image-generation.ts';
import { MessageStore } from './message-store.ts';
import type { DatabaseConfig, Job } from './message-store.ts';
import { syncMessages, sendText, sendImage, uploadImage, sendFile, uploadFileMedia, WecomApiError } from './wecom-api.ts';
import type { KfMessage, WecomApiConfig } from './wecom-api.ts';
import { errorCode, retryable } from './http-client.ts';
import { diagnoseSendFailure } from './send-diagnostics.ts';

export interface WorkerConfig extends WecomApiConfig, DatabaseConfig { maxConcurrentJobs: number; maxQueueSize: number; dailyRequestLimit: number;
  syncPollMs: number; retryBaseMs: number; maxSendAttempts: number; retentionDays: number;
  progressNoticeMs?: number; progressIntervalMs?: number;
}
export class MessageWorker {
  store: MessageStore;
  private cfg: WorkerConfig;
  private handler: (msg: KfMessage, session: string | undefined, progress: TaskProgress) => Promise<BotReply>;
  private timer?: ReturnType<typeof setTimeout>;
  private active = new Map<string, Promise<void>>();
  private syncing?: Promise<void>;
  private pumping?: Promise<void>;
  private notifications = new Set<Promise<void>>();
  private closing = false;
  private pendingWrites = 0;
  private lastPoll = Date.now();
  private lastCleanup = Date.now();
  private tokens = new Map<string, { value: string; expires: number }>();
  private constructor(cfg: WorkerConfig, handler: MessageWorker['handler'], store: MessageStore) {
    this.cfg = cfg;
    this.handler = handler;
    this.store = store;
  }
  static async create(cfg: WorkerConfig, handler: MessageWorker['handler']): Promise<MessageWorker> {
    const store = await MessageStore.open(cfg);
    try { await store.cleanup(cfg.retentionDays); return new MessageWorker(cfg, handler, store); }
    catch (error) { await store.close(); throw error; }
  }
  start(): void { this.wake(); }
  async notify(kfid: string, token: string): Promise<void> {
    if (this.closing) throw new Error('SHUTTING_DOWN');
    const write = this.store.notify(kfid);
    this.notifications.add(write);
    try {
      // A callback is acknowledged only after the sync job commits.
      await write;
      if (token) this.tokens.set(kfid, { value: token, expires: Date.now() + 9 * 60000 });
      this.wake();
    } finally { this.notifications.delete(write); }
  }
  private delay(attempt: number): number {
    return Math.min(60000, this.cfg.retryBaseMs * 2 ** Math.min(attempt, 10)) * (1 + Math.random() * 0.2);
  }
  private wake(): void {
    if (this.closing || this.pumping) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.pumping = this.pump().finally(() => { this.pumping = undefined; this.schedule(); });
    }, 25);
    this.timer.unref();
  }
  private schedule(): void {
    if (this.closing) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.wake(), 100);
    this.timer.unref();
  }
  private async pump(): Promise<void> {
    if (this.closing || !this.store.healthy) return;
    try {
      if (Date.now() - this.lastCleanup > 3600000) {
        await this.store.cleanup(this.cfg.retentionDays); this.lastCleanup = Date.now();
      }
      if (Date.now() - this.lastPoll >= this.cfg.syncPollMs) {
        await this.store.pollKnown(); this.lastPoll = Date.now();
      }
      if (!this.syncing && (await this.store.pendingCount()) < this.cfg.maxQueueSize) {
        const job = await this.store.syncReady();
        if (job && !this.closing) {
          const task = (async () => {
            try {
              const cached = this.tokens.get(job.kfid);
              const token = cached && cached.expires > Date.now() ? cached.value : '';
              const available = this.cfg.maxQueueSize - (await this.store.pendingCount());
              const data = await syncMessages(this.cfg, { cursor: job.cursor, token, openKfId: job.kfid, limit: Math.min(1000, available) });
              const more = data.has_more === 1;
              const cursor = data.next_cursor || job.cursor;
              if (more && cursor === job.cursor) throw new Error('CURSOR_STALLED');
              await this.store.acceptPage(job, data.msg_list || [], cursor, more, this.cfg.maxQueueSize);
            } catch (error) {
              console.error('[sync]', errorCode(error));
              await this.store.deferSync(job, Math.max(1000, this.delay(job.attempts)));
            }
          })();
          this.syncing = task;
          void task.catch(() => console.error('[sync]', 'STORAGE_ERROR')).finally(() => { this.syncing = undefined; this.wake(); });
        }
      }
      const slots = this.cfg.maxConcurrentJobs - this.active.size;
      if (slots > 0 && this.pendingWrites === 0) {
        for (const job of await this.store.nextJobs(this.cfg.maxConcurrentJobs)) {
          if (this.closing || !this.store.healthy || this.pendingWrites > 0 || this.active.size >= this.cfg.maxConcurrentJobs) break;
          if (this.active.has(job.user_key)) continue;
          await this.store.start(job);
          if (this.closing) break;
          const task = this.process(job);
          this.active.set(job.user_key, task);
          void task.catch(() => console.error('[worker]', 'STORAGE_ERROR')).finally(() => {
            this.active.delete(job.user_key); this.wake();
          });
        }
      }
    } catch { console.error('[worker]', 'STORAGE_ERROR'); }

  }
  private async process(job: Job): Promise<void> {
    if (job.status === 'pending') {
      let result: BotReply;
      try {
        const msg = JSON.parse(job.payload) as KfMessage;
        const billable = ['text', 'image', 'file'].includes(msg.msgtype || '') && !(msg.msgtype === 'text' && msg.text?.content?.trim().startsWith('/') && drawingPrompt(msg.text.content) === null);
        if (billable && !(await this.store.charge(job, this.cfg.dailyRequestLimit))) {
          result = { chunks: ['今天的使用次数已到上限，明天再聊吧～'] };
        } else {
          const session = await this.store.session(job.user_key);
          result = await this.handleWithProgress(job, msg, session, billable);
        }
      } catch {
        // No result was generated; fail visibly rather than loop indefinitely on a corrupt session.
        result = { chunks: ['暂时无法处理这条消息，请稍后重试。'] };
      }
      // Keep the generated result alive across database / connection failures. Never rerun the
      // paid handler merely because committing its result failed. Pause new model work.
      let blocked = false;
      try {
        while (true) {
          try {
            if (!(await this.store.saveReply(job, result.session, result.chunks))) {
              console.error('[send]', 'REPLY_BUDGET_EXHAUSTED', 'FAILED'); return;
            }
            break;
          }
          catch {
            if (!blocked) { this.pendingWrites++; blocked = true; console.error('[worker]', 'REPLY_STORAGE_UNAVAILABLE'); }
            if (this.closing || !this.store.healthy) return; // processing remains durable for restart recovery
            await new Promise((r) => setTimeout(r, 250));
          }
        }
      } finally { if (blocked) this.pendingWrites--; }
    }
    const [, user] = JSON.parse(job.user_key) as [string, string];
    try {
      for (const part of await this.store.parts(job)) {
        if (part.part > 0) await new Promise((r) => setTimeout(r, 400));
        if (!this.store.healthy) return;
        if (part.kind === 'image' || part.kind === 'file') {
          const sendMedia = part.kind === 'file' ? sendFile : sendImage;
          let mediaId = part.media_id;
          const upload = async () => {
            const bytes = Buffer.from(part.content, 'base64');
            const id = part.kind === 'file'
              ? await uploadFileMedia(this.cfg, bytes, part.filename || '')
              : await uploadImage(this.cfg, bytes);
            // Keep original bytes until send confirmation so expired media can be reuploaded.
            await this.store.setMedia(job, part.part, id, Date.now() + 2 * 86400000);
            return id;
          };
          if (!mediaId || Number(part.media_expires_at) <= Date.now()) mediaId = await upload();
          try { await sendMedia(this.cfg, { touser: user, openKfId: job.kfid, msgid: part.msgid, mediaId }); }
          catch (error) {
            if (!(error instanceof WecomApiError) || error.errcode !== 40007) throw error;
            mediaId = await upload();
            await sendMedia(this.cfg, { touser: user, openKfId: job.kfid, msgid: part.msgid, mediaId });
          }
        } else {
          await sendText(this.cfg, { touser: user, openKfId: job.kfid, msgid: part.msgid, content: part.content });
        }
        await this.store.markPart(job, part.part);
      }
      await this.store.done(job);
    } catch (error) {
      const terminal = !retryable(error) || job.attempts + 1 >= this.cfg.maxSendAttempts;
      console.error('[send]', errorCode(error), terminal ? 'FAILED' : 'RETRY');
      await this.store.defer(job, this.delay(job.attempts), terminal);
      const diagnosis = await diagnoseSendFailure(this.cfg, error, job.kfid, user);
      if (diagnosis) console.error('[send-diagnosis]', diagnosis);
    }
  }
  private async handleWithProgress(job: Job, msg: KfMessage, session: string | undefined, enabled: boolean): Promise<BotReply> {
    let finished = false, blocked = false, sequence = 0;
    let publicText = '';
    let attempts = await this.store.progressAttempts(job);
    let sentText = await this.store.progressText(job);
    let notice: Promise<void> | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    const firstDelay = this.cfg.progressNoticeMs ?? 3000;
    const interval = this.cfg.progressIntervalMs ?? 30000;
    const progress: TaskProgress = {
      activity: () => {}, // Transport liveness still refreshes model idle timeouts.
      text: value => { publicText = value; },
    };
    const tick = () => {
      if (finished || blocked || attempts >= MAX_INTERMEDIATE_MESSAGES || this.closing || !this.store.healthy) return;
      notice = (async () => {
        try {
          const pending = publicText.startsWith(sentText) ? publicText.slice(sentText.length) : '';
          const content = intermediateContent(pending);
          if (!content) return;
          const publicPart = true;
          const attempt = ++sequence;
          const msgid = await this.store.claimProgress(job, content, attempt, publicPart);
          attempts = await this.store.progressAttempts(job);
          if (!msgid || finished || this.closing || !this.store.healthy) {
            return;
          }
          const [, user] = JSON.parse(job.user_key) as [string, string];
          await sendText({ ...this.cfg, upstreamTimeoutMs: Math.min(this.cfg.upstreamTimeoutMs ?? 30000, 3000) },
            { touser: user, openKfId: job.kfid, msgid, content });
          // Track delivery before the database write: a storage fault must not cause
          // the same public prefix to be sent again within this execution.
          sentText += content;
          await this.store.markProgress(job, attempt, publicPart);
        } catch (error) {
          console.error('[progress]', errorCode(error));
          // Channel refusal stops notices, not generation or final delivery.
          blocked = true;
        }
      })().finally(() => {
        if (!finished && !blocked && attempts < MAX_INTERMEDIATE_MESSAGES && !this.closing) { timer = setTimeout(tick, interval); timer.unref(); }
      });
    };
    if (enabled && firstDelay > 0) { timer = setTimeout(tick, firstDelay); timer.unref(); }
    let result: BotReply;
    try { result = await this.handler(msg, session, progress); }
    finally {
      finished = true;
      if (timer) clearTimeout(timer);
      await notice;
    }
    if (sentText) {
      let prefix = '';
      for (const chunk of result.chunks) { if (typeof chunk !== 'string') break; prefix += chunk; }
      if (prefix.startsWith(sentText)) {
        let remaining = sentText.length;
        result = { ...result, chunks: result.chunks.flatMap(chunk => {
          if (typeof chunk !== 'string' || remaining === 0) return [chunk];
          const tail = chunk.slice(remaining); remaining = Math.max(0, remaining - chunk.length);
          return tail ? [tail] : [];
        }) };
      }
    }
    return result;
  }

  async stop(): Promise<void> {
    this.closing = true;
    clearTimeout(this.timer);
    if (this.pumping) await this.pumping;
    await Promise.allSettled([...this.notifications, ...this.active.values(), ...(this.syncing ? [this.syncing] : [])]);
    await this.store.close();
  }
}
