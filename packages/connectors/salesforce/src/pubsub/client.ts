/**
 * Pub/Sub API gRPC client (RQ-0036 F1, ADR-0032): TLS to the configured endpoint, auth as call
 * metadata (`accesstoken`, `instanceurl`, `tenantid`). Plaintext is allowed only to a loopback
 * address, for the local fake server in tests.
 */
import {
  credentials,
  Metadata,
  type Client,
  type ClientDuplexStream,
  type ServiceClientConstructor,
  type ServiceError,
} from '@grpc/grpc-js';
import {
  loadPubSubPackage,
  PUBSUB_DEFAULT_ENDPOINT,
  type FetchRequestMessage,
  type FetchResponseMessage,
  type SchemaInfoMessage,
} from './proto.ts';

export interface PubSubAuth {
  /** OAuth access token of the integration user (T-0063 connection store). */
  accessToken: string;
  /** https://<my domain>.my.salesforce.com from the token response. */
  instanceUrl: string;
  /** The 18-character org id. */
  tenantId: string;
}

export function pubSubMetadata(auth: PubSubAuth): Metadata {
  const m = new Metadata();
  m.set('accesstoken', auth.accessToken);
  m.set('instanceurl', auth.instanceUrl);
  m.set('tenantid', auth.tenantId);
  return m;
}

export type SubscribeCall = ClientDuplexStream<FetchRequestMessage, FetchResponseMessage>;

export interface PubSubClient {
  subscribe(metadata: Metadata): SubscribeCall;
  getSchema(schemaId: string, metadata: Metadata): Promise<SchemaInfoMessage>;
  close(): void;
}

type RawPubSubClient = Client & {
  Subscribe(metadata: Metadata): SubscribeCall;
  GetSchema(
    req: { schemaId: string },
    metadata: Metadata,
    cb: (err: ServiceError | null, res?: SchemaInfoMessage) => void,
  ): void;
};

const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/;

export function createPubSubClient(
  endpoint: string = PUBSUB_DEFAULT_ENDPOINT,
  opts: { insecure?: boolean } = {},
): PubSubClient {
  if (opts.insecure && !LOOPBACK.test(endpoint)) {
    throw new Error('pubsub: plaintext gRPC is only allowed to a loopback test server');
  }
  const pkg = loadPubSubPackage().grpc as unknown as {
    eventbus: { v1: { PubSub: ServiceClientConstructor } };
  };
  const raw = new pkg.eventbus.v1.PubSub(
    endpoint,
    opts.insecure ? credentials.createInsecure() : credentials.createSsl(),
  ) as unknown as RawPubSubClient;
  return {
    subscribe: (metadata) => raw.Subscribe(metadata),
    getSchema: (schemaId, metadata) =>
      new Promise((resolve, reject) => {
        raw.GetSchema({ schemaId }, metadata, (err, res) => {
          if (err || !res) reject(err ?? new Error('pubsub: empty GetSchema response'));
          else resolve(res);
        });
      }),
    close: () => {
      raw.close();
    },
  };
}
