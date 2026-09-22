import { useEffect, useState } from 'react';
import type { Dataset } from '@datera/core';
import type { DateraApi } from '../shared/contract.js';
import { Models } from './Models.js';
import { Environments } from './Environments.js';
import { Connect } from './Connect.js';
import { Privacy } from './Privacy.js';

/**
 * Settings — the things you set once.
 *
 * Models, servers, connect configs, retention and write grants used to be four nav items
 * and two buried tabs, each styled as a workspace. None of them is a place you work, and
 * a sidebar that gives setup the same weight as querying tells a new user the product is
 * mostly setup.
 *
 * Write grants are the one thing that did *not* end up here. They belong beside the
 * datasets they apply to, in Data — a permission you cannot see from the place it takes
 * effect is a permission people forget they granted. Privacy shows which datasets are
 * currently writable, and points at where to change that.
 */
type Tab = 'models' | 'servers' | 'serving' | 'privacy';

const TABS: readonly { readonly id: Tab; readonly label: string; readonly blurb: string }[] = [
  { id: 'models', label: 'Models', blurb: 'Which model writes your SQL, and whose machine it runs on.' },
  { id: 'servers', label: 'Servers', blurb: 'This machine, and any Datera Server you have deployed.' },
  { id: 'serving', label: 'Serving', blurb: 'How an agent connects to this workspace.' },
  { id: 'privacy', label: 'Privacy', blurb: 'What gets recorded, for how long, and what may be changed.' },
];

export function Settings({
  api,
  datasets,
  datasetId,
  onClose,
}: {
  readonly api: DateraApi;
  readonly datasets: readonly Dataset[];
  readonly datasetId: string;
  readonly onClose: () => void;
}): JSX.Element {
  const [tab, setTab] = useState<Tab>('models');

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const current = TABS.find((t) => t.id === tab)!;

  return (
    <>
      <div className="scrim show" onClick={onClose} />
      <div className="settings" role="dialog" aria-label="Settings" data-settings>
        <div className="seth">
          <h2>Settings</h2>
          <button className="x" data-close-settings onClick={onClose}>×</button>
        </div>

        <div className="setbody">
          <nav className="settabs">
            {TABS.map((t) => (
              <button
                key={t.id}
                data-settab={t.id}
                className={tab === t.id ? 'on' : ''}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </nav>

          <div className="setpane">
            <p className="tierdesc">{current.blurb}</p>
            {tab === 'models' && <Models api={api} datasetId={datasetId} />}
            {tab === 'servers' && <Environments api={api} datasets={datasets} />}
            {tab === 'serving' && <Connect api={api} />}
            {tab === 'privacy' && <Privacy api={api} datasets={datasets} />}
          </div>
        </div>
      </div>
    </>
  );
}
