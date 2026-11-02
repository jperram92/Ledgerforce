export {
  deltaSoql,
  parseModstamp,
  POLL_SEQUENCE_BASE,
  pollFields,
  polledChange,
  soqlDateTime,
} from './delta.ts';
export {
  describeFields,
  fetchHttpGet,
  queryAllPages,
  type HttpGet,
  type QuerySession,
  type SfRecord,
} from './query-client.ts';
export {
  configureSyncObject,
  getSyncObject,
  pollObject,
  reconcileInbound,
  runPollingCycle,
  type PollContext,
  type PollOptions,
  type PollReport,
  type SyncMode,
  type SyncObject,
} from './poller.ts';
