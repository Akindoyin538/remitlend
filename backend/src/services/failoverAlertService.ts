import logger from '../utils/logger.js';

export interface FailoverEvent {
  timestamp: Date;
  type: 'failover_activated' | 'failover_deactivated' | 'connection_retry';
  details: {
    attempt?: number;
    backoffMs?: number;
    error?: string;
    isRead?: boolean;
  };
}

const failoverEvents: FailoverEvent[] = [];
const MAX_EVENTS = 100;

export function recordFailoverEvent(event: Omit<FailoverEvent, 'timestamp'>): void {
  const failoverEvent: FailoverEvent = {
    timestamp: new Date(),
    ...event,
  };

  failoverEvents.push(failoverEvent);
  if (failoverEvents.length > MAX_EVENTS) {
    failoverEvents.shift();
  }

  switch (event.type) {
    case 'failover_activated':
      logger.error('DATABASE FAILOVER ACTIVATED', {
        timestamp: failoverEvent.timestamp.toISOString(),
        details: event.details,
      });
      sendFailoverAlert(failoverEvent);
      break;

    case 'failover_deactivated':
      logger.warn('Database failover deactivated - primary recovered', {
        timestamp: failoverEvent.timestamp.toISOString(),
      });
      sendFailoverRecoveryAlert(failoverEvent);
      break;

    case 'connection_retry':
      logger.debug('Database connection retry', {
        attempt: event.details.attempt,
        backoffMs: event.details.backoffMs,
      });
      break;
  }
}

export function getFailoverEvents(limit: number = 50): FailoverEvent[] {
  return failoverEvents.slice(-limit);
}

export function isCurrentlyFailingOver(): boolean {
  if (failoverEvents.length === 0) return false;
  const lastEvent = failoverEvents[failoverEvents.length - 1];
  return lastEvent.type === 'failover_activated';
}

async function sendFailoverAlert(event: FailoverEvent): Promise<void> {
  const webhookUrl = process.env.FAILOVER_ALERT_WEBHOOK;
  if (!webhookUrl) {
    logger.debug('No failover webhook configured');
    return;
  }

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        severity: 'critical',
        title: 'Database Failover Activated',
        description: `Primary database connection failed. Failover to replica activated at ${event.timestamp.toISOString()}`,
        details: event.details,
      }),
    });

    if (!response.ok) {
      logger.error('Failover alert webhook failed', { status: response.status });
    }
  } catch (error) {
    logger.error('Failed to send failover alert', { error });
  }
}

async function sendFailoverRecoveryAlert(event: FailoverEvent): Promise<void> {
  const webhookUrl = process.env.FAILOVER_ALERT_WEBHOOK;
  if (!webhookUrl) {
    return;
  }

  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        severity: 'info',
        title: 'Database Failover Deactivated',
        description: `Primary database recovered at ${event.timestamp.toISOString()}. Failover mode disabled.`,
      }),
    });
  } catch (error) {
    logger.debug('Failed to send recovery alert', { error });
  }
}

/** Emit a CRITICAL alert (log + optional FAILOVER_ALERT_WEBHOOK) for non-failover incidents. */
export async function sendCriticalAlert(
  title: string,
  description: string,
  details: Record<string, unknown> = {},
): Promise<void> {
  logger.error(`CRITICAL ALERT: ${title}`, { description, details });
  const webhookUrl = process.env.FAILOVER_ALERT_WEBHOOK;
  if (!webhookUrl) return;
  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ severity: 'critical', title, description, details }),
    });
  } catch (error) {
    logger.error('Failed to send critical alert', { error });
  }
}
