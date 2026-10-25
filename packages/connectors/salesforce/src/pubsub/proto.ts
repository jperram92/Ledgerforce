/**
 * The Salesforce Pub/Sub API contract (RQ-0036 S1, ADR-0032): `proto/pubsub_api.proto` is the
 * forcedotcom file byte for byte (CC0-1.0), pinned by SHA-256 in the contract test. The client
 * and the local fake server are both built from it, so neither can drift from the wire layout.
 */
import { loadPackageDefinition, type GrpcObject } from '@grpc/grpc-js';
import { loadSync, type PackageDefinition } from '@grpc/proto-loader';
import { fileURLToPath } from 'node:url';

export const PUBSUB_PROTO_PATH = fileURLToPath(
  new URL('../../proto/pubsub_api.proto', import.meta.url),
);
export const PUBSUB_PROTO_SHA256 =
  '0a651295ff3ff13551b3ae7cb6fe87cf91b749a8ae33b6079617dbc62f304eb5';

/** Global endpoint (RQ-0036 S6); a region-specific endpoint can be configured instead. */
export const PUBSUB_DEFAULT_ENDPOINT = 'api.pubsub.salesforce.com:7443';

/** Maximum events outstanding per Subscribe stream (RQ-0036 S5). */
export const MAX_NUM_REQUESTED = 100;

export type ReplayPreset = 'LATEST' | 'EARLIEST' | 'CUSTOM';

/** Message shapes as decoded by proto-loader with the options below (camelCase keys). */
export interface FetchRequestMessage {
  topicName?: string;
  replayPreset?: ReplayPreset;
  replayId?: Buffer;
  numRequested?: number;
}
export interface ProducerEventMessage {
  id: string;
  schemaId: string;
  payload: Buffer;
  headers: { key: string; value: Buffer }[];
}
export interface ConsumerEventMessage {
  event: ProducerEventMessage | null;
  replayId: Buffer;
}
export interface FetchResponseMessage {
  events: ConsumerEventMessage[];
  latestReplayId: Buffer;
  rpcId: string;
  pendingNumRequested: number;
}
export interface SchemaInfoMessage {
  schemaJson: string;
  schemaId: string;
  rpcId: string;
}

let cached: { definition: PackageDefinition; grpc: GrpcObject } | undefined;

/** Load the proto once: enums as names, bytes as Buffers, defaults filled in. */
export function loadPubSubPackage(): { definition: PackageDefinition; grpc: GrpcObject } {
  if (!cached) {
    const definition = loadSync(PUBSUB_PROTO_PATH, {
      keepCase: false,
      enums: String,
      longs: String,
      bytes: Buffer,
      defaults: true,
      oneofs: false,
    });
    cached = { definition, grpc: loadPackageDefinition(definition) };
  }
  return cached;
}
