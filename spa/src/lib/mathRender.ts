import type katex from 'katex';

type KatexApi = typeof katex;

/**
 * M36 — the only module that references KaTeX. Vite splits it (and the KaTeX
 * CSS, and its fonts) into a separate chunk; `App` never imports it directly,
 * so first-screen JS stays byte-for-byte the same size class as before.
 *
 * The CSS import lives inside the dynamic import so the stylesheet (and the
 * font URLs it declares) is fetched only when a message actually contains a
 * complete math span.
 */
let loading: Promise<KatexApi | null> | null = null;

export function loadKatex(): Promise<KatexApi | null> {
  if (!loading) {
    loading = (async () => {
      try {
        const [module] = await Promise.all([
          import('katex'),
          import('katex/dist/katex.min.css'),
        ]);
        const api = (module as { default?: KatexApi }).default ?? (module as unknown as KatexApi);
        return api;
      } catch (error) {
        // A failed chunk fetch must not break the chat: placeholders stay as
        // literal `$...$` source.
        console.warn('math: KaTeX failed to load', error);
        return null;
      }
    })();
  }
  return loading;
}

/**
 * Render every pending placeholder under `root`.
 *
 * Safe to call on every markdown update: placeholders carry a state marker, so
 * a no-op pass costs one querySelectorAll. Because M32 re-injects the frozen
 * head HTML when a new block completes, previously hydrated nodes disappear
 * and their replacements are pending again — that is exactly why hydration is
 * DOM-driven instead of cached alongside the HTML string.
 */
export function hydrateMath(root: HTMLElement | null): void {
  if (!root) return;
  const nodes = Array.from(
    root.querySelectorAll<HTMLElement>('.math[data-math-state="pending"]'),
  );
  if (nodes.length === 0) return;
  for (const node of nodes) node.dataset.mathState = 'loading';

  void loadKatex().then((api) => {
    for (const node of nodes) {
      // The node may have been replaced by a newer head render while the
      // chunk was in flight; the replacement is handled by its own pass.
      if (!node.isConnected || node.dataset.mathState !== 'loading') continue;
      const tex = node.dataset.tex ?? '';
      if (!api || tex.length === 0) {
        node.dataset.mathState = 'failed';
        continue;
      }
      const displayMode = node.classList.contains('math-block');
      try {
        api.render(tex, node, {
          displayMode,
          throwOnError: false,
          strict: 'ignore',
          trust: false,
        });
        node.dataset.mathState = 'done';
        node.title = '点击复制 LaTeX 源码';
      } catch (error) {
        // KaTeX threw despite throwOnError:false (e.g. an unsupported macro in
        // an old version). Put the literal source back instead of a
        // half-written tree, so the message still reads as plain text.
        console.warn('math: render failed', error);
        node.textContent = displayMode ? `$$${tex}$$` : `$${tex}$`;
        node.dataset.mathState = 'failed';
      }
    }
  });
}
