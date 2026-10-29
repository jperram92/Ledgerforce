/**
 * Test-only local Pub/Sub API server (RQ-0036, ADR-0032), built from the vendored proto, so the
 * client talks real gRPC to it. It follows the published behaviour the subscriber relies on:
 * call-metadata auth; the replay option is honoured on the first FetchRequest only (LATEST,
 * EARLIEST, CUSTOM = after the id); at most 100 events outstanding per stream, delivered in
 * batches of up to `maxBatch`; keepalives carry the latest replay id; an unknown or expired replay
 * id ends the stream with INVALID_ARGUMENT and the `error-code` trailer. It also lets a test
 * redeliver an event (at-least-once delivery).
 */
import {
  Metadata,
  Server,
  ServerCredentials,
  status as GrpcStatus,
  type sendUnaryData,
  type ServerDuplexStream,
  type ServerUnaryCall,
  type ServiceClientConstructor,
} from '@grpc/grpc-js';
import { REPLAY_ID_CORRUPTED } from '../pubsub/errors.ts';
import {
  loadPubSubPackage,
  MAX_NUM_REQUESTED,
  type ConsumerEventMessage,
  type FetchRequestMessage,
  type FetchResponseMessage,
  type SchemaInfoMessage,
} from '../pubsub/proto.ts';

export interface FakeRequest {
  topicName: string;
  replayPreset: string;
  /** Hex of the replay id sent, or null when empty. */
  replayId: string | null;
  numRequested: number;
}

export interface FakeStream {
  requests: FakeRequest[];
}

export interface FakePubSub {
  address: string;
  /** Every Subscribe stream that sent a first request, in order. */
  streams: FakeStream[];
  setMaxBatch(n: number): void;
  registerSchema(id: string, json: string): void;
  /** Append events to the topic and deliver them to open streams; returns their replay ids. */
  publish(
    topic: string,
    events: { eventId: string; schemaId: string; payload: Buffer }[],
  ): Buffer[];
  /** Deliver an already published event again to every open stream of the topic. */
  redeliver(topic: string, replayId: Buffer): void;
  /** Send an empty keepalive response carrying the topic's latest replay id; returns it. */
  keepalive(topic: string): Buffer;
  /** Make every event published so far fall out of retention. */
  expireAll(topic: string): void;
  waitForStreams(n: number): Promise<void>;
  close(): Promise<void>;
}

interface Topic {
  log: ConsumerEventMessage[];
  retainedFrom: number;
  /** Replay id of the tip when nothing has been published yet. */
  tip: Buffer;
}

interface Live {
  topic: string;
  call: ServerDuplexStream<FetchRequestMessage, FetchResponseMessage>;
  position: number;
  outstanding: number;
  redeliveries: ConsumerEventMessage[];
  open: boolean;
  record: FakeStream;
}

export async function startFakePubSub(opts: {
  auth: { accessToken: string; tenantId: string };
  maxBatch?: number;
}): Promise<FakePubSub> {
  let maxBatch = opts.maxBatch ?? 100;
  let nextReplay = 20_000n;
  const newReplayId = () => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64BE((nextReplay += 1n));
    return b;
  };
  const topics = new Map<string, Topic>();
  const topicOf = (name: string) => {
    let t = topics.get(name);
    if (!t) {
      t = { log: [], retainedFrom: 0, tip: newReplayId() };
      topics.set(name, t);
    }
    return t;
  };
  const schemas = new Map<string, string>();
  const streams: FakeStream[] = [];
  const live: Live[] = [];
  const waiters: { n: number; resolve: () => void }[] = [];
  let rpc = 0;
  const rpcId = () => `fake-${String((rpc += 1))}`;

  const fail = (l: Live, code: GrpcStatus, details: string, errorCode: string) => {
    const metadata = new Metadata();
    metadata.set('error-code', errorCode);
    l.open = false;
    l.call.emit('error', { code, details: `${details} rpcId: ${rpcId()}`, metadata });
  };
  const authorised = (m: Metadata) =>
    m.get('accesstoken')[0] === opts.auth.accessToken &&
    m.get('tenantid')[0] === opts.auth.tenantId &&
    String(m.get('instanceurl')[0] ?? '').startsWith('https://');

  const pump = (l: Live) => {
    const t = topicOf(l.topic);
    while (
      l.open &&
      l.outstanding > 0 &&
      (l.redeliveries.length > 0 || l.position < t.log.length)
    ) {
      const n = Math.min(maxBatch, l.outstanding);
      const batch = l.redeliveries.splice(0, n);
      while (batch.length < n && l.position < t.log.length) {
        batch.push(t.log[l.position] as ConsumerEventMessage);
        l.position += 1;
      }
      l.outstanding -= batch.length;
      l.call.write({
        events: batch,
        latestReplayId: (batch.at(-1) as ConsumerEventMessage).replayId,
        rpcId: rpcId(),
        pendingNumRequested: l.outstanding,
      });
    }
  };

  const subscribe = (call: ServerDuplexStream<FetchRequestMessage, FetchResponseMessage>) => {
    let l: Live | undefined;
    call.on('data', (req: FetchRequestMessage) => {
      const asked = req.numRequested ?? 0;
      if (l) {
        l.record.requests.push({
          topicName: req.topicName ?? '',
          replayPreset: req.replayPreset ?? 'LATEST',
          replayId: req.replayId?.length ? req.replayId.toString('hex') : null,
          numRequested: asked,
        });
        if (req.topicName && req.topicName !== l.topic) {
          fail(l, GrpcStatus.INVALID_ARGUMENT, 'topic changed', 'sfdc.fake.topic');
          return;
        }
        l.outstanding = Math.min(MAX_NUM_REQUESTED, l.outstanding + asked);
        pump(l);
        return;
      }
      const topic = req.topicName ?? '';
      const t = topicOf(topic);
      const record: FakeStream = {
        requests: [
          {
            topicName: topic,
            replayPreset: req.replayPreset ?? 'LATEST',
            replayId: req.replayId?.length ? req.replayId.toString('hex') : null,
            numRequested: asked,
          },
        ],
      };
      l = {
        topic,
        call,
        position: t.log.length,
        outstanding: Math.min(MAX_NUM_REQUESTED, asked),
        redeliveries: [],
        open: true,
        record,
      };
      streams.push(record);
      for (const w of waiters.filter((x) => streams.length >= x.n)) w.resolve();
      if (!authorised(call.metadata)) {
        fail(
          l,
          GrpcStatus.UNAUTHENTICATED,
          'bad auth',
          'sfdc.platform.eventbus.grpc.service.auth.error',
        );
        return;
      }
      if (req.replayPreset === 'EARLIEST') l.position = t.retainedFrom;
      if (req.replayPreset === 'CUSTOM') {
        const at = req.replayId
          ? t.log.findIndex((e) => e.replayId.equals(req.replayId as Buffer))
          : -1;
        if (at < t.retainedFrom) {
          fail(
            l,
            GrpcStatus.INVALID_ARGUMENT,
            'The Replay ID validation failed.',
            REPLAY_ID_CORRUPTED,
          );
          return;
        }
        l.position = at + 1;
      }
      live.push(l);
      pump(l);
    });
    const close = () => {
      if (l) l.open = false;
    };
    call.on('cancelled', close);
    call.on('end', () => {
      close();
      call.end();
    });
    call.on('error', close);
  };

  const getSchema = (
    call: ServerUnaryCall<{ schemaId: string }, SchemaInfoMessage>,
    cb: sendUnaryData<SchemaInfoMessage>,
  ) => {
    const json = schemas.get(call.request.schemaId);
    if (!authorised(call.metadata)) cb({ code: GrpcStatus.UNAUTHENTICATED, details: 'bad auth' });
    else if (!json) cb({ code: GrpcStatus.NOT_FOUND, details: 'unknown schema' });
    else cb(null, { schemaJson: json, schemaId: call.request.schemaId, rpcId: rpcId() });
  };

  const pkg = loadPubSubPackage().grpc as unknown as {
    eventbus: { v1: { PubSub: ServiceClientConstructor } };
  };
  const server = new Server();
  const unimplemented = (_: unknown, cb?: sendUnaryData<unknown>) =>
    cb?.({ code: GrpcStatus.UNIMPLEMENTED, details: 'not in the fake' });
  server.addService(pkg.eventbus.v1.PubSub.service, {
    Subscribe: subscribe,
    GetSchema: getSchema,
    GetTopic: unimplemented,
    Publish: unimplemented,
    PublishStream: unimplemented,
    ManagedSubscribe: unimplemented,
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.bindAsync('127.0.0.1:0', ServerCredentials.createInsecure(), (err, p) => {
      if (err) reject(err);
      else resolve(p);
    });
  });

  const openOn = (topic: string) => live.filter((l) => l.open && l.topic === topic);
  return {
    address: `127.0.0.1:${String(port)}`,
    streams,
    setMaxBatch: (n) => {
      maxBatch = n;
    },
    registerSchema: (id, json) => {
      schemas.set(id, json);
    },
    publish: (topic, events) => {
      const t = topicOf(topic);
      const ids = events.map((e) => {
        const replayId = newReplayId();
        t.log.push({
          replayId,
          event: { id: e.eventId, schemaId: e.schemaId, payload: e.payload, headers: [] },
        });
        return replayId;
      });
      for (const l of openOn(topic)) pump(l);
      return ids;
    },
    redeliver: (topic, replayId) => {
      const ev = topicOf(topic).log.find((e) => e.replayId.equals(replayId));
      if (!ev) throw new Error('fake: no such event');
      for (const l of openOn(topic)) {
        l.redeliveries.push(ev);
        pump(l);
      }
    },
    keepalive: (topic) => {
      const t = topicOf(topic);
      const tip = t.log.at(-1)?.replayId ?? t.tip;
      for (const l of openOn(topic)) {
        l.call.write({
          events: [],
          latestReplayId: tip,
          rpcId: rpcId(),
          pendingNumRequested: l.outstanding,
        });
      }
      return tip;
    },
    expireAll: (topic) => {
      const t = topicOf(topic);
      t.retainedFrom = t.log.length;
    },
    waitForStreams: (n) =>
      new Promise<void>((resolve) => {
        if (streams.length >= n) resolve();
        else waiters.push({ n, resolve });
      }),
    close: () =>
      new Promise<void>((resolve) => {
        server.tryShutdown(() => {
          resolve();
        });
        for (const l of live) if (l.open) l.call.end();
      }),
  };
}
