import type { AgentEvent } from '../events/events.js'

/**
 * Where a run's events are recorded so a disconnected client can pick them up
 * again.
 *
 * This is not the session store. A session holds the *conversation* and lives as
 * long as the user; a stream holds one run's *events* and lives for minutes. The
 * shapes look similar because both are append-only logs, but their lifetimes and
 * their contents are unrelated, and merging them would tie a chat history's
 * retention to a reconnect window.
 */
export interface StreamStore {
  /** Records events at the end of the log, preserving order. */
  append(streamId: string, events: readonly AgentEvent[]): Promise<void>

  /** Events from `fromIndex` onward. An unknown stream returns an empty array. */
  read(streamId: string, fromIndex: number): Promise<AgentEvent[]>

  /** Marks the run over. `read` after this returns the tail and stops. */
  finish(streamId: string, outcome: StreamOutcome): Promise<void>

  /** How far the log has got, and whether more is coming. */
  status(streamId: string): Promise<StreamStatus>
}

export type StreamOutcome = 'finish' | 'error'

export interface StreamStatus {
  /** Events recorded so far. */
  readonly count: number
  /** No more events will arrive. */
  readonly done: boolean
  /** How the run ended, once it has. */
  readonly outcome?: StreamOutcome
}

/**
 * Prefix for a generated stream id, e.g. `stream_m9x2k1p_a7f3z9`. Distinct from
 * a run id so a client can be handed one without learning the other.
 *
 * No trailing underscore: `createId` adds the separator.
 */
export const STREAM_ID_PREFIX = 'stream'
