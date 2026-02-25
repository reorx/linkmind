export const AgentEventType = {
  SESSION_START: 'session_start',
  SESSION_END: 'session_end',
  STEP_START: 'step_start',
  STEP_END: 'step_end',
  MESSAGE: 'message',
} as const;

export type AgentEventTypeValue = (typeof AgentEventType)[keyof typeof AgentEventType];

export const AgentSessionStatus = {
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
} as const;

export type AgentSessionStatusValue = (typeof AgentSessionStatus)[keyof typeof AgentSessionStatus];
