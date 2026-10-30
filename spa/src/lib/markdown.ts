import { Marked } from 'marked';
import { mathExtensions } from './math';

/**
 * The one `marked` instance used by the app. Its defaults are the M19 options
 * (`gfm`, `breaks`); the M36 math extensions add block/inline tokens whose
 * renderers emit inert placeholders (see `lib/math.ts`). The KaTeX library is
 * deliberately absent from this module: it only arrives through the dynamic
 * import in `lib/mathRender.ts`.
 */
export const md = new Marked({
  gfm: true,
  breaks: true,
  extensions: mathExtensions,
});
