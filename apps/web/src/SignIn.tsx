/**
 * Sign-in entry (SS-PLAT-52): the person names their organisation and the whole page goes to the
 * API's `/t/<slug>/auth/login`, which redirects to the identity provider (T-0011, RQ-0025).
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useServices } from './env.tsx';
import { pageTitle } from './sections.ts';
import { checkSlug } from './slug.ts';

export type SignInReason = 'signed-out' | 'expired';

const NOTICE: Record<SignInReason, string> = {
  'signed-out': 'You have signed out.',
  expired: 'Sign in to continue. If you were signed in, your session has ended.',
};

export function SignInPage({ reason }: { reason?: SignInReason | undefined }) {
  const { api, env } = useServices();
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    document.title = pageTitle('Sign in');
  }, []);

  function submit(e: FormEvent) {
    e.preventDefault();
    const checked = checkSlug(value);
    if (!checked.ok) {
      setError(checked.message);
      input.current?.focus();
      return;
    }
    setError(null);
    env.goExternal(api.loginUrl(checked.slug));
  }

  return (
    <>
      <header className="top">
        <div className="org">LedgerForce</div>
      </header>
      <main id="main" className="signin">
        <h1>Sign in to LedgerForce</h1>
        {reason ? (
          <p className="notice" role="status">
            {NOTICE[reason]}
          </p>
        ) : null}
        <p>You sign in on your organisation's own sign-in page. Tell us which one.</p>
        <form onSubmit={submit} noValidate>
          <label htmlFor="slug">Your organisation's sign-in name</label>
          <p id="slug-hint" className="hint">
            The short name in your sign-in link, for example harbour-co.
          </p>
          <input
            ref={input}
            id="slug"
            name="slug"
            type="text"
            autoComplete="organization"
            autoCapitalize="none"
            spellCheck={false}
            value={value}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'slug-hint slug-error' : 'slug-hint'}
            onChange={(e) => {
              setValue(e.target.value);
            }}
          />
          {error ? (
            <p id="slug-error" className="error">
              {error}
            </p>
          ) : null}
          <button type="submit" className="primary">
            Continue to sign in
          </button>
        </form>
      </main>
    </>
  );
}
