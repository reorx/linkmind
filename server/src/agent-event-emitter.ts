import crypto from 'crypto';
import type pino from 'pino';
import { logger } from './logger.js';
import { createAgentSession, updateAgentSessionStatus, insertAgentEvent } from './db/index.js';
import { AgentEventType, AgentSessionStatus } from './types/agent-event.js';

export class AgentEventEmitter {
  private refType: string;
  private refId: string;
  private agentName: string;
  private sessionId: string | null = null;
  private log: pino.Logger;

  constructor(opts: { refType: string; refId: string; agentName: string }) {
    this.refType = opts.refType;
    this.refId = opts.refId;
    this.agentName = opts.agentName;
    this.log = logger.child({
      module: 'agent-event',
      refType: opts.refType,
      refId: opts.refId,
      agentName: opts.agentName,
    });
  }

  async startSession(): Promise<string> {
    const id = crypto.randomBytes(8).toString('hex');
    await createAgentSession({ id, refType: this.refType, refId: this.refId, agentName: this.agentName });
    this.sessionId = id;
    await insertAgentEvent({ sessionId: id, eventType: AgentEventType.SESSION_START });
    this.log.info('[session] Started');
    return id;
  }

  async endSession(status: 'completed' | 'failed', error?: string): Promise<void> {
    if (!this.sessionId) return;
    const dbStatus = status === 'completed' ? AgentSessionStatus.COMPLETED : AgentSessionStatus.FAILED;
    await updateAgentSessionStatus(this.sessionId, dbStatus, error);
    await insertAgentEvent({
      sessionId: this.sessionId,
      eventType: AgentEventType.SESSION_END,
      data: { status, error },
    });
    if (status === 'failed') {
      this.log.error({ error }, '[session] Ended');
    } else {
      this.log.info('[session] Ended');
    }
  }

  async emitStepStart(stepName: string, meta?: Record<string, unknown>): Promise<void> {
    if (!this.sessionId) return;
    await insertAgentEvent({
      sessionId: this.sessionId,
      eventType: AgentEventType.STEP_START,
      name: stepName,
      data: meta,
    });
    this.log.info({ step: stepName, ...meta }, `[${stepName}] Starting`);
  }

  async emitStepEnd(stepName: string, meta?: Record<string, unknown>, durationMs?: number): Promise<void> {
    if (!this.sessionId) return;
    await insertAgentEvent({
      sessionId: this.sessionId,
      eventType: AgentEventType.STEP_END,
      name: stepName,
      data: { ...meta, durationMs },
    });
    this.log.info({ step: stepName, durationMs, ...meta }, `[${stepName}] Done`);
  }

  async emitMessage(message: string, meta?: Record<string, unknown>): Promise<void> {
    if (!this.sessionId) return;
    await insertAgentEvent({
      sessionId: this.sessionId,
      eventType: AgentEventType.MESSAGE,
      data: { message, ...meta },
    });
    this.log.info({ ...meta }, message);
  }

  getSessionId(): string | null {
    return this.sessionId;
  }
}
