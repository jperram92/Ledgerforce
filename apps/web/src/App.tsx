/** The web app: services, TanStack Query and the router (T-0081). Styles are imported by main.tsx. */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, type RouterHistory } from '@tanstack/react-router';
import { useState } from 'react';
import { createAdminClient } from './admin/client.ts';
import { createApiClient } from './api.ts';
import { ServicesContext, type AppEnv } from './env.tsx';
import { createGlClient } from './gl/client.ts';
import { createAppRouter } from './router.tsx';

export function App({ env, history }: { env: AppEnv; history?: RouterHistory }) {
  const [state] = useState(() => ({
    services: {
      env,
      api: createApiClient(env),
      admin: createAdminClient(env),
      gl: createGlClient(env),
    },
    // No automatic retries: a failed session check shows its error and a Retry button at once.
    queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    router: createAppRouter(history),
  }));
  return (
    <ServicesContext value={state.services}>
      <QueryClientProvider client={state.queryClient}>
        <RouterProvider router={state.router} />
      </QueryClientProvider>
    </ServicesContext>
  );
}
