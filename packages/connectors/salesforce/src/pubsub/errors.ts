/**
 * Pub/Sub API errors (RQ-0036 F4): a gRPC status ends the Subscribe stream; Salesforce's own code
 * is in the `error-code` trailer and the RPC id follows "rpcId:" in the message.
 */
import { status as GrpcStatus, type ServiceError } from '@grpc/grpc-js';

export const REPLAY_ID_CORRUPTED =
  'sfdc.platform.eventbus.grpc.subscription.fetch.replayid.corrupted';
/** The documented replay-id error and its siblings: the stored id cannot be resumed from. */
const REPLAY_ID_FAMILY = 'sfdc.platform.eventbus.grpc.subscription.fetch.replayid.';

export type PubSubErrorKind = 'replay_id_invalid' | 'auth' | 'transient' | 'cancelled' | 'fatal';

export interface PubSubErrorInfo {
  kind: PubSubErrorKind;
  grpcCode: number;
  errorCode: string | null;
  rpcId: string | null;
  message: string;
}

const TRANSIENT = new Set<number>([
  GrpcStatus.UNAVAILABLE,
  GrpcStatus.INTERNAL,
  GrpcStatus.DEADLINE_EXCEEDED,
  GrpcStatus.RESOURCE_EXHAUSTED,
  GrpcStatus.ABORTED,
  GrpcStatus.UNKNOWN,
]);

export function classifyPubSubError(err: Partial<ServiceError>): PubSubErrorInfo {
  const grpcCode = typeof err.code === 'number' ? err.code : GrpcStatus.UNKNOWN;
  const trailer = err.metadata?.get('error-code')[0];
  const errorCode = typeof trailer === 'string' ? trailer : (trailer?.toString('utf8') ?? null);
  const message = err.message ?? '';
  const rpcId = /rpcId:\s*([A-Za-z0-9-]+)/.exec(message)?.[1] ?? null;
  let kind: PubSubErrorKind;
  if (errorCode?.startsWith(REPLAY_ID_FAMILY)) kind = 'replay_id_invalid';
  else if (grpcCode === GrpcStatus.UNAUTHENTICATED || grpcCode === GrpcStatus.PERMISSION_DENIED)
    kind = 'auth';
  else if (grpcCode === GrpcStatus.CANCELLED) kind = 'cancelled';
  else if (TRANSIENT.has(grpcCode)) kind = 'transient';
  else kind = 'fatal';
  return { kind, grpcCode, errorCode, rpcId, message };
}

export class PubSubError extends Error {
  readonly info: PubSubErrorInfo;
  constructor(info: PubSubErrorInfo) {
    super(`pubsub ${info.kind}: ${info.errorCode ?? `gRPC ${String(info.grpcCode)}`}`);
    this.name = 'PubSubError';
    this.info = info;
  }
}
