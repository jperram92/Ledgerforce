/** Page bodies rendered inside the shell: section placeholders and not-found (T-0081). */
import { Link } from '@tanstack/react-router';
import { useEffect, useId } from 'react';
import { pageTitle, type Section } from './sections.ts';

function useTitle(name: string) {
  useEffect(() => {
    document.title = pageTitle(name);
  }, [name]);
}

/** A section with nothing in it yet: what it is, and an empty state saying what will appear. */
export function SectionPage({ section }: { section: Section }) {
  useTitle(section.name);
  const id = useId();
  return (
    <>
      <div className="head">
        <h1 tabIndex={-1}>{section.heading}</h1>
        <p>{section.gloss}</p>
      </div>
      <section className="empty" data-state="empty" aria-labelledby={id}>
        <h2 id={id}>{section.emptyHeading}</h2>
        <p>{section.emptyText}</p>
      </section>
    </>
  );
}

export function NotFoundPage() {
  useTitle('Page not found');
  return (
    <div className="head">
      <h1 tabIndex={-1}>Page not found</h1>
      <p>There is no page at this address.</p>
      <p className="next">
        <Link to="/">Go to your timeline</Link>
      </p>
    </div>
  );
}
