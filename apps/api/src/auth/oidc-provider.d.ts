/**
 * Minimal types for `oidc-provider` 9 (a dev dependency, used only as the in-process test IdP in
 * oidc.db.test.ts; RQ-0020). The package ships no types. Only the members the tests use are
 * declared, so a wrong use fails typecheck instead of becoming `any`.
 */
declare module 'oidc-provider' {
  import type { IncomingMessage, ServerResponse } from 'node:http';

  export interface LoginResult {
    /** `ts`: authentication time in seconds (becomes the ID token's auth_time; default now). */
    login: { accountId: string; acr?: string; amr?: string[]; remember?: boolean; ts?: number };
  }

  export interface GrantInstance {
    addOIDCScope(scope: string): void;
    save(): Promise<string>;
  }

  export interface KoaishContext {
    oidc: {
      client?: { clientId: string };
      session?: { accountId?: string };
      provider: { Grant: new (init: { clientId: string; accountId: string }) => GrantInstance };
    };
  }

  export interface Configuration {
    clients: {
      client_id: string;
      client_secret: string;
      redirect_uris: string[];
    }[];
    features?: { devInteractions?: { enabled: boolean } };
    interactions?: { url: (ctx: unknown, interaction: { uid: string }) => string };
    acrValues?: string[];
    claims?: Record<string, string[] | null>;
    findAccount: (
      ctx: unknown,
      sub: string,
    ) => { accountId: string; claims: () => Record<string, unknown> };
    loadExistingGrant?: (ctx: KoaishContext) => Promise<GrantInstance | undefined>;
  }

  export default class Provider {
    constructor(issuer: string, configuration: Configuration);
    callback(): (req: IncomingMessage, res: ServerResponse) => void;
    interactionFinished(
      req: IncomingMessage,
      res: ServerResponse,
      result: LoginResult,
      options?: { mergeWithLastSubmission?: boolean },
    ): Promise<void>;
  }
}
