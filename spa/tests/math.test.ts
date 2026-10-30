import { describe, expect, it } from 'vitest';
import { mathHtml, readDisplayMath, readInlineMath, scanMath } from '../src/lib/math';
import { md } from '../src/lib/markdown';

const texts = (text: string) => scanMath(text).map((span) => span.tex);

describe('inline pairing', () => {
  it('pairs a simple $...$ on one line', () => {
    expect(texts('能量是 $E = mc^2$。')).toEqual(['E = mc^2']);
    expect(scanMath('能量是 $E = mc^2$。')[0]).toMatchObject({ display: false });
  });

  it('keeps spaces inside the formula but rejects whitespace at the edges', () => {
    expect(texts('$a + b$')).toEqual(['a + b']);
    expect(texts('$ a + b$')).toEqual([]);
    expect(texts('$a + b $')).toEqual([]);
    expect(texts('$ $')).toEqual([]);
  });

  it('pairs several formulas in one paragraph', () => {
    expect(texts('$a$ 和 $b$ 与 $c$')).toEqual(['a', 'b', 'c']);
  });

  it('does not cross a newline', () => {
    expect(texts('$a +\nb$')).toEqual([]);
    expect(texts('第一行 $a$\n第二行 $b$')).toEqual(['a', 'b']);
  });

  it('treats an escaped dollar as literal', () => {
    expect(texts('\\$x\\$')).toEqual([]);
    expect(readInlineMath('\\$x\\$')).toBeNull();
    expect(texts('\\$a\\$ 与 $b$')).toEqual(['b']);
  });

  it('never throws on an unclosed opener', () => {
    expect(() => scanMath('价格是 $x')).not.toThrow();
    expect(texts('价格是 $x')).toEqual([]);
    expect(texts('$')).toEqual([]);
    expect(texts('$$x')).toEqual([]);
  });
});

describe('currency guard', () => {
  it('leaves $5 and $10 as text', () => {
    expect(texts('这里 $5 和 $10 都不该变成公式')).toEqual([]);
    expect(texts('cost $5 and $10')).toEqual([]);
  });

  it('rejects a closer that sits right before a digit', () => {
    expect(readInlineMath('$5 and $10 for two')).toBeNull();
    expect(texts('$100-$200')).toEqual([]);
    expect(texts('$5, $6, $7')).toEqual([]);
  });

  it('still accepts a balanced formula whose body starts with a digit', () => {
    expect(texts('$2 + 2 = 4$')).toEqual(['2 + 2 = 4']);
  });

  it('finds a real formula after currency text', () => {
    expect(texts('花了 $5，然后 $x$')).toEqual(['x']);
    expect(texts('$5 and $10, or $x^2$')).toEqual(['x^2']);
  });
});

describe('display pairing', () => {
  it('pairs a single-line $$...$$', () => {
    expect(scanMath('$$E = mc^2$$')[0]).toMatchObject({
      tex: 'E = mc^2',
      display: true,
    });
  });

  it('pairs a multi-line block and trims it', () => {
    const text = '前文\n\n$$\n\\int_0^1 x^2 \\, dx = \\frac{1}{3}\n$$\n\n后文';
    expect(texts(text)).toEqual(['\\int_0^1 x^2 \\, dx = \\frac{1}{3}']);
  });

  it('allows up to three spaces of indentation', () => {
    expect(texts('   $$a^2$$')).toEqual(['a^2']);
  });

  it('does not treat an unclosed block as math', () => {
    expect(texts('$$\n\\int_0^1 x')).toEqual([]);
    expect(texts('$$a')).toEqual([]);
  });

  it('pairs $$...$$ inline when it is not a block of its own', () => {
    expect(texts('公式 $$a^2$$ 在句中')).toEqual(['a^2']);
    expect(readDisplayMath('$$a$$')).not.toBeNull();
  });

  it('handles escaped dollars inside a block', () => {
    expect(texts('$$a \\$ b$$')).toEqual(['a \\$ b']);
  });
});

describe('code exemption', () => {
  it('ignores $ inside fenced code', () => {
    const text = '```js\nconst price = "$5 and $10";\nconst f = "$x$";\n```';
    expect(texts(text)).toEqual([]);
  });

  it('ignores math-looking text in a tilde fence and keeps scanning after it', () => {
    const text = '~~~\n$$a$$\n~~~\n\n外面 $b$';
    expect(texts(text)).toEqual(['b']);
  });

  it('ignores $ inside inline code', () => {
    expect(texts('代码 `$x$` 保持原样')).toEqual([]);
    expect(texts('``a ` $x$ `` 与 $y$')).toEqual(['y']);
  });

  it('keeps the fenced block opaque even when the fence is unclosed', () => {
    expect(texts('```\n$x$')).toEqual([]);
  });
});

describe('mathHtml placeholders', () => {
  it('renders literal source until hydration and escapes the source', () => {
    const html = mathHtml('a<b & "c"', false);
    expect(html).toContain('data-math-state="pending"');
    expect(html).toContain('data-tex="a&lt;b &amp; &quot;c&quot;"');
    expect(html).toContain('$a&lt;b &amp; &quot;c&quot;$');
    expect(html).not.toContain('<b');
  });

  it('marks display placeholders with the block class', () => {
    expect(mathHtml('x', true)).toContain('class="math math-block"');
    expect(mathHtml('x', true)).toContain('$$x$$');
  });
});

describe('marked integration', () => {
  it('emits one inline placeholder instead of emphasis tokens', () => {
    const html = md.parse('$a_1 + a_2$') as string;
    expect(html).toContain('class="math math-inline"');
    expect(html).toContain('data-tex="a_1 + a_2"');
    expect(html).not.toContain('<em>');
  });

  it('emits a block placeholder for a standalone $$ block', () => {
    const html = md.parse('前\n\n$$\nE = mc^2\n$$\n\n后') as string;
    expect(html).toContain('class="math math-block"');
    expect(html.match(/class="math math-block"/g)).toHaveLength(1);
  });

  it('leaves $ inside code spans and fences untouched', () => {
    const span = md.parse('`$x$`') as string;
    expect(span).toContain('<code>$x$</code>');
    expect(span).not.toContain('class="math');
    const fence = md.parse('```\n$$a$$\n```') as string;
    expect(fence).toContain('<pre><code>$$a$$');
    expect(fence).not.toContain('class="math');
  });

  it('leaves an indented code block alone', () => {
    const html = md.parse('    const tex = "$x$";') as string;
    expect(html).toContain('<pre><code>');
    expect(html).not.toContain('class="math');
  });

  it('leaves currency text alone', () => {
    const html = md.parse('价格 $5 和 $10') as string;
    expect(html).not.toContain('class="math');
    expect(html).toContain('$5 和 $10');
  });

  it('keeps math tokens on the streaming lexer/parser path', () => {
    // Regression guard: passing a per-call options object to `md.lexer`
    // replaces the instance's extension registry, so the streaming renderer
    // would drop every math token and only render after the message settles.
    const tokens = md.lexer('前 $a$ 后');
    const html = md.parser(tokens) as string;
    expect(html).toContain('class="math math-inline"');
    expect(html).not.toContain('<em>');
  });

  it('renders inline math inside table cells', () => {
    const html = md.parse('| a | b |\n| --- | --- |\n| $x$ | 2 |') as string;
    expect(html).toContain('class="math math-inline"');
  });
});
