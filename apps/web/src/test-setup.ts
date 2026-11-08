// Vitest runs without globals, so Testing Library cannot register its own cleanup: unmount every
// rendered tree after each test so queries never see a previous test's DOM (as packages/ui).
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
});
