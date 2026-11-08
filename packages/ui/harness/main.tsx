/**
 * Static fixture page for @ledgerforce/ui (T-0106, SS-PLAT-29): every Timeline component with the
 * Harbour & Co data, no Storybook. Served by tests/e2e/ui-system.spec.ts through Vite.
 */
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../src/styles/tokens.css';
import '../src/styles/timeline.css';
import './harness.css';
import { JournalTable, Money, Spine, Timeline, TurnQueue } from '../src/index.ts';
import {
  HARBOUR_LAST_STATEMENT,
  HARBOUR_TODAY,
  harbourCash,
  harbourDecisions,
  harbourJournal,
  harbourLanes,
  harbourSpine,
} from '../src/fixtures/harbour.ts';

const LEAVES_OUT =
  'Overdue invoices (33,482.50, 8 invoices) are not counted in the expected balance.';

function Page() {
  const [opened, setOpened] = useState('');
  const spine = harbourSpine.map((e) =>
    e.id === 'posted'
      ? {
          ...e,
          detail: <JournalTable journal={harbourJournal.journal} lines={harbourJournal.lines} />,
        }
      : e,
  );
  return (
    <>
      <header className="top">
        <div className="org">Harbour &amp; Co Pty Ltd</div>
        <div className="me">
          Sam Nguyen <span>Owner</span>
        </div>
      </header>
      <main id="main">
        <div className="head">
          <h1>Your money from 1 October to 9 November</h1>
          <p>
            Solid is what has happened, to the bank statement of Fri 23 Oct. Dashed is what is due
            to happen if customers pay on their due dates and you pay on yours.
          </p>
        </div>

        <section className="block" aria-labelledby="h-tl">
          <h2 id="h-tl">Timeline</h2>
          <Timeline
            label="Cash and obligations over time"
            today={HARBOUR_TODAY}
            lastStatement={HARBOUR_LAST_STATEMENT}
            cash={harbourCash}
            cashScale={{
              min: '100000',
              max: '215000',
              grid: ['120000', '150000', '180000', '210000'],
            }}
            lanes={harbourLanes}
            leavesOut={LEAVES_OUT}
          />
        </section>

        <div className="cols">
          <section className="block" aria-labelledby="h-dec">
            <h2 id="h-dec">Decisions, by the day they block something</h2>
            <p className="muted">Each names who acts next. Four are yours.</p>
            <TurnQueue
              label="Decisions waiting on someone"
              items={harbourDecisions}
              today={HARBOUR_TODAY}
              onOpen={(id) => {
                const it = harbourDecisions.find((d) => d.id === id);
                setOpened(it ? (it.what.split(',')[0] ?? it.what) : id);
              }}
            />
            <p role="status" className="muted">
              {opened ? `Opened ${opened}` : ''}
            </p>
          </section>

          <section className="block" aria-labelledby="h-inv">
            <h2 id="h-inv">INV-001061 for Saltbush Health, its life so far</h2>
            <p className="muted">
              Every step stays on the record. Corrections add steps; they never remove one.
            </p>
            <Spine label="Life of INV-001061" events={spine} today={HARBOUR_TODAY} />
          </section>
        </div>

        <section className="block" aria-labelledby="h-money">
          <h2 id="h-money">How amounts read</h2>
          <div className="scroll">
            <table className="tbl">
              <caption className="sr-only">Amounts in accountant and owner views</caption>
              <thead>
                <tr>
                  <th scope="col">What</th>
                  <th scope="col" className="num">
                    Amount
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Invoice total</td>
                  <td className="num">
                    <Money value="10087.00" />
                  </td>
                </tr>
                <tr>
                  <td>Refund (money out)</td>
                  <td className="num">
                    <Money value="-389.00" />
                  </td>
                </tr>
                <tr>
                  <td>Nothing owed</td>
                  <td className="num">
                    <Money value="0" />
                  </td>
                </tr>
                <tr>
                  <td>GST reserve, four decimals rounded half-up</td>
                  <td className="num">
                    <Money value="12440.3550" />
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="sentence">
            On Wed 28 Oct, <Money value="-12604.10" sign="words" /> to the ATO for the BAS, and
            Saltbush owes you <Money value="10087.00" />.
          </p>
        </section>
      </main>
    </>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('harness: #root missing');
createRoot(root).render(
  <StrictMode>
    <Page />
  </StrictMode>,
);
