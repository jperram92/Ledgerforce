/**
 * Shared pieces of the Sync issues screens (T-0092): the client (built from the injected
 * environment, so App and env stay unchanged), query keys, who may read, and refusals in plain
 * words. Loading, error, forbidden and step-up routing come from the admin screens (T-0093).
 */
import { useMemo } from 'react';
import { useServices } from '../env.tsx';
import { AdminApiError } from '../admin/client.ts';
import { createSyncClient, type SyncClient } from './client.ts';
import { syncMessageFor } from './logic.ts';

export const SYNC_KEY = ['sync', 'issues'] as const;
export const issueKey = (id: string) => [...SYNC_KEY, 'one', id] as const;

export const SYNC_READERS = 'Only the Owner, a Finance Admin, an Accountant or an Auditor';
export const SYNC_MANAGERS = 'Only the Owner, a Finance Admin or an Accountant';

export const NOT_AFFECTED =
  'Your books are not affected: documents keep posting while Salesforce is behind.';

export function useSyncClient(): SyncClient {
  const { env } = useServices();
  return useMemo(() => createSyncClient(env), [env]);
}

/** A refusal next to the action that caused it; step-up and ended sessions navigate instead. */
export function SyncRefusal({ error }: { error: unknown }) {
  if (!error) return null;
  if (error instanceof AdminApiError && error.status === 401) return null;
  return (
    <p className="refusal" role="alert">
      {syncMessageFor(error)}
    </p>
  );
}
