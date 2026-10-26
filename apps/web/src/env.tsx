/**
 * What the app needs from its surroundings, injected so components are tested without a browser
 * (DL-0110): the API base (same origin in production, RQ-0025), `fetch`, and full-page navigation
 * (sign-in must leave the SPA for the API's login redirect).
 */
import { createContext, useContext } from 'react';
import type { AdminClient } from './admin/client.ts';
import type { ApiClient } from './api.ts';
import type { GlClient } from './gl/client.ts';

export interface AppEnv {
  /** Prefix for API paths; '' means the page's own origin. */
  apiBase: string;
  fetch: typeof globalThis.fetch;
  /** Leave the app for another URL (the API's tenant login). */
  goExternal: (url: string) => void;
}

export function browserEnv(): AppEnv {
  return {
    apiBase: '',
    fetch: (input, init) => window.fetch(input, init),
    goExternal: (url) => {
      window.location.assign(url);
    },
  };
}

export interface Services {
  env: AppEnv;
  api: ApiClient;
  /** Administration routes (T-0093). */
  admin: AdminClient;
  /** Chart of accounts and manual journals (T-0082). */
  gl: GlClient;
}

export const ServicesContext = createContext<Services | null>(null);

export function useServices(): Services {
  const s = useContext(ServicesContext);
  if (!s) throw new Error('ServicesContext is missing: render inside <App>');
  return s;
}
