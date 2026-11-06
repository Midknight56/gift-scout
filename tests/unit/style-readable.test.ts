import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('readable stylesheet sizes', () => {
  it('keeps every declared font size at least 14 pixels, except short labels at 12', async () => {
    const css = await readFile(new URL('../../public/style.css', import.meta.url), 'utf8');
    const exceptions = new Set(['.call-number', '.cached-badge', '.result-type', '.say-line::before', '.turn-mark', '.card-list.earlier::before']);
    const failures: string[] = [];
    const rulePattern = /([^{}]+)\{([^{}]*)\}/g;
    for (const match of css.matchAll(rulePattern)) {
      const selector = match[1].trim().replace(/^[\s\S]*?\n\s*/, '').trim();
      const body = match[2];
      for (const sizeMatch of body.matchAll(/font-size\s*:\s*([\d.]+)px\b/g)) {
        const size = Number(sizeMatch[1]);
        const isUppercase = /text-transform\s*:\s*uppercase\b/i.test(body);
        const allowedMinimum = isUppercase || exceptions.has(selector) ? 12 : 14;
        if (size < allowedMinimum) failures.push(`${selector}: ${size}px is below ${allowedMinimum}px`);
      }
    }
    expect(failures, failures.join('\n')).toEqual([]);
  });

  it('keeps result scores at 14px or larger', async () => {
    const css = await readFile(new URL('../../public/style.css', import.meta.url), 'utf8');
    const rule = css.match(/\.result-score\s*\{([^}]*)\}/)?.[1] ?? '';
    const size = rule.match(/font(?:-size)?\s*:\s*([\d.]+)px/)?.[1];
    expect(Number(size)).toBeGreaterThanOrEqual(14);
  });
});


it.each(['.result-type', '.turn-mark', '.card-list.earlier::before', '.say-line::before'])('keeps %s at least 14px', async selector => {
  const css = await readFile(new URL('../../public/style.css', import.meta.url), 'utf8')
  const body = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find(match => match[1].trim() === selector)?.[2] ?? ''
  expect(Number(body.match(/font-size\s*:\s*([\d.]+)px/)?.[1])).toBeGreaterThanOrEqual(14)
})
