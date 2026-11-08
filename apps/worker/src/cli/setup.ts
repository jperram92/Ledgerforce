/**
 * First-start setup of a self-hosted install (the compose `setup` service, T-0094):
 * `node apps/worker/src/cli/setup.ts` — configuration from the environment (setup-config.ts).
 * Exits non-zero on any failure so api and worker (which wait for it) do not start.
 */
import { KeycloakAdmin } from '../setup/keycloak-admin.ts';
import { setupConfigFromEnv } from '../setup/setup-config.ts';
import { runSetup } from '../setup/setup.ts';

try {
  const config = setupConfigFromEnv(process.env);
  await runSetup(config.setup, new KeycloakAdmin(config.keycloak), (line) => console.log(line));
} catch (error) {
  console.error(`LedgerForce setup failed: ${(error as Error).message}`);
  process.exit(1);
}
