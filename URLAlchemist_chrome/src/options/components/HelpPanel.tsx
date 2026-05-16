import { useEffect, useMemo, useState } from 'react';

interface HelpDocument {
  path: string;
  title: string;
  summary: string;
}

const HELP_DOCUMENTS: HelpDocument[] = [
  { path: 'help/index.html', title: 'Overview', summary: 'Core concepts, tabs, and quick start.' },
  { path: 'help/workspaces.html', title: 'Workspaces', summary: 'Build, save, restore, and edit workspace source files.' },
  { path: 'help/action-packs.html', title: 'Action Packs', summary: 'Compile, import, export, pair, and manage Action Packs.' },
  { path: 'help/security.html', title: 'Security', summary: 'Transparency, sandboxing, tracing, hardening, and audits.' },
  { path: 'help/regex-builder.html', title: 'Regex Builder', summary: 'Use the visual regex helper and advanced manual mode.' },
  { path: 'help/overlay-input.html', title: 'Overlay Input', summary: 'Capture keyboard and mouse input while an overlay is active.' },
  { path: 'help/interactive-overlays.html', title: 'Interactive Overlays', summary: 'Build event-driven overlay apps with generic blocks.' },
];

function getHelpUrl(path: string): string {
  const chromeApi = (globalThis as unknown as { chrome?: typeof chrome }).chrome;
  return chromeApi?.runtime?.getURL ? chromeApi.runtime.getURL(path) : `/${path}`;
}

function extractHelpBody(content: string): string {
  const document = new DOMParser().parseFromString(content, 'text/html');
  // Remove known dangerous elements
  document.querySelectorAll('script, iframe, object, embed, base, meta[http-equiv]').forEach((node) => node.remove());
  // Sanitize attributes across all remaining elements
  document.querySelectorAll('*').forEach((node) => {
    [...node.attributes].forEach((attribute) => {
      const name = attribute.name.toLowerCase();
      if (name.startsWith('on')) {
        node.removeAttribute(attribute.name);
      } else if (name === 'style' && /(?:url\s*\(|@import)/i.test(attribute.value)) {
        // Remove inline styles that reference external resources
        node.removeAttribute(attribute.name);
      } else if (name === 'href' && /^\s*javascript\s*:/i.test(attribute.value)) {
        // Remove javascript: URIs from links
        node.removeAttribute(attribute.name);
      }
    });
  });

  return document.body.innerHTML.trim() || content;
}

export function HelpPanel() {
  const [activePath, setActivePath] = useState(HELP_DOCUMENTS[0].path);
  const [html, setHtml] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const visibleDocuments = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) {
      return HELP_DOCUMENTS;
    }

    return HELP_DOCUMENTS.filter((document) =>
      `${document.title} ${document.summary}`.toLowerCase().includes(normalized),
    );
  }, [query]);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    void fetch(getHelpUrl(activePath))
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Unable to load ${activePath}`);
        }
        return response.text();
      })
      .then((content) => {
        if (!cancelled) {
          setHtml(extractHelpBody(content));
        }
      })
      .catch((fetchError) => {
        if (!cancelled) {
          setHtml('');
          setError(fetchError instanceof Error ? fetchError.message : 'Unable to load help content.');
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activePath]);

  return (
    <section className="panel-shell reveal-panel">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="eyebrow">Help</p>
          <h2 className="mt-2 text-2xl font-semibold text-slate-900">Documentation</h2>
          <p className="mt-2 max-w-3xl text-sm text-slate-600">Search and browse packaged documentation for the options-page features.</p>
        </div>
      </div>

      <div className="mt-6 grid gap-5 lg:grid-cols-[280px_1fr]">
        <aside className="rounded-[1.25rem] border border-slate-200 bg-white/75 p-4">
          <label className="field-shell">
            <span className="field-label">Search help</span>
            <input className="field-input" placeholder="Search sections" value={query} onChange={(event) => setQuery(event.target.value)} />
          </label>
          <div className="mt-4 grid gap-2">
            {visibleDocuments.map((document) => (
              <button
                key={document.path}
                className={`rounded-2xl px-4 py-3 text-left transition ${activePath === document.path ? 'bg-slate-900 text-white' : 'bg-white text-slate-700 hover:bg-amber-50'}`}
                type="button"
                onClick={() => setActivePath(document.path)}
              >
                <span className="block text-sm font-semibold">{document.title}</span>
                <span className={`mt-1 block text-xs ${activePath === document.path ? 'text-slate-200' : 'text-slate-500'}`}>{document.summary}</span>
              </button>
            ))}
            {visibleDocuments.length === 0 ? <p className="rounded-2xl bg-slate-50 px-4 py-3 text-sm text-slate-500">No help sections match that search.</p> : null}
          </div>
        </aside>

        <article className="min-h-[640px] max-h-[760px] overflow-y-auto rounded-[1.25rem] border border-slate-200 bg-white shadow-[0_12px_28px_rgba(15,23,42,0.07)]">
          {error ? (
            <p className="p-6 text-sm text-rose-700">{error}</p>
          ) : (
            <div className="help-document" dangerouslySetInnerHTML={{ __html: html }} />
          )}
        </article>
      </div>
    </section>
  );
}
