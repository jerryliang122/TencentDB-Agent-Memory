/**
 * TDAI Core — barrel re-export for core types.
 *
 * This module exports ONLY the host-neutral interfaces.
 */

export type {
  Logger,
  RuntimeContext,
  LLMRunParams,
  LLMRunner,
  LLMRunnerCreateOptions,
  LLMRunnerFactory,
  HostAdapter,
  CompletedTurn,
  RecallResult,
  CaptureResult,
  MemorySearchParams,
  ConversationSearchParams,
} from "./types.js";
