import { describe, expect, it } from 'vitest';
// @ts-expect-error Public renderer is an ES module without a TypeScript declaration.
import { cardHtml, callRowHtml, callSummary, compareHtml, panelSummary, priceBand, walkSvg } from '../../public/render.js';

describe('render helpers', () => {
  it('summarizes each tool call in plain words', () => {
    expect(callSummary({ tool: 'search_entities', args: { query: 'Le Carre', type: 'brand' } }, {})).toBe('Find "Le Carre" in Qloo as a brand');
    expect(callSummary({ tool: 'search_tags', args: { query: 'Korean' } }, {})).toBe('Find the tag for "Korean"');
    expect(callSummary({ tool: 'taste_insights', args: { seed_ids: ['1'], seed_tags: ['2'], target_type: 'brand', location: 'Toronto', audience_gender: 'male', audience_age: '55_and_older' } }, { '1': 'John le Carré', '2': 'Lagavulin' })).toBe('What fans of John le Carré and Lagavulin love: brands in Toronto (audience: male, 55 and older)');
    expect(callSummary({ tool: 'buy_gift', args: { card_id: 't1c1', amount_usd: 22.5 } }, {})).toBe('Buy card t1c1 for $22.50');
    expect(callSummary({ tool: 'other_tool', args: {} }, {})).toBe('other_tool');
  });

  it('uses a taste label for unknown seed ids', () => {
    expect(callSummary({ tool: 'taste_insights', args: { seed_ids: ['missing'], target_type: 'book' } }, {})).toBe('What fans of a taste love: books');
  });

  it('escapes call summaries in rendered HTML', () => {
    const html = callRowHtml({ t: 'call', n: 1, tool: 'search_entities', args: { query: '<b>' } }, null);
    expect(html).toContain('<p class="call-summary">Find &quot;&lt;b&gt;&quot; in Qloo</p>');
  });

  it('escapes untrusted gift and entity names', () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const html = cardHtml({ gift: hostile, why: 'Thoughtful', price_low: 5, price_high: 5, entity: { name: hostile, affinity: 0.8 }, seeds: [], from_call: 1 });
    expect(html).not.toContain('<img');
    expect(html.match(/&lt;img/g)).toHaveLength(3);
  });

  it('formats price bands', () => {
    expect(priceBand(25, 40)).toBe('$25 to $40');
    expect(priceBand(30, 30)).toBe('$30');
  });

  it('renders an escaped product block and only allows HTTPS image and link URLs', () => {
    const card = { gift: 'Gift', why: 'Why', price_low: 20, price_high: 80, entity: { name: 'Entity' }, seeds: [], from_call: 1,
      product: { title: '<strap>', brand: 'Fender & Co', price: 75, url: 'https://shop.test/?x=1&y=2', image: 'https://cdn.test/image?a=1&b=2', source: 'channel3' } };
    const html = cardHtml(card);
    expect(html).toContain('&lt;strap&gt;');
    expect(html).toContain('Fender &amp; Co');
    expect(html).toContain('$75.00');
    expect(html).toContain('href="https://shop.test/?x=1&amp;y=2" target="_blank" rel="noopener noreferrer nofollow"');
    expect(html).toContain('src="https://cdn.test/image?a=1&amp;b=2" alt="&lt;strap&gt;" width="64" height="64" loading="lazy"');
    expect(cardHtml({ ...card, product: { ...card.product, image: 'http://cdn.test/image' } })).not.toContain('http://cdn.test/image');
    expect(html).toContain('Found by Channel3');
  });

  it('keeps card output unchanged without a product', () => {
    const html = cardHtml({ gift: 'Gift', why: 'Why', price_low: 1, price_high: 1, entity: { name: 'Entity' }, seeds: [], from_call: 1 });
    expect(html).not.toContain('product-block');
    expect(html).not.toContain('Found by Channel3');
  });

  it('summarizes Channel3 product searches', () => {
    expect(callSummary({ tool: 'search_products', args: { query: 'Fender strap', max_price: 60 } })).toBe('Find "Fender strap" to buy, under $60');
    expect(panelSummary([{ t: 'result', tool: 'search_entities' }, { t: 'result', tool: 'search_products' }])).toBe('1 Qloo call, 1 product search');
  });

  it('shows arguments, elapsed time, and only a cached badge when cached', () => {
    const call = { t: 'call', n: 4, tool: 'taste_insights', args: { query: 'Phoebe', limit: 4 } };
    const uncached = callRowHtml(call, { n: 4, tool: 'taste_insights', ok: true, ms: 123, cached: false, text: 'Done', top: [] });
    expect(uncached).toContain('Phoebe');
    expect(uncached).toContain('123 ms');
    expect(uncached).not.toContain('cached-badge');
    const cached = callRowHtml(call, { n: 4, tool: 'taste_insights', ok: true, ms: 12, cached: true, text: 'Done', top: [] });
    expect(cached).toContain('cached-badge');
  });

  it('formats affinity to two decimal places', () => {
    const html = cardHtml({ gift: 'Gift', why: 'Why', price_low: 1, price_high: 1, entity: { name: 'Entity', affinity: 0.9307 }, seeds: [], from_call: 4 });
    expect(html).toContain('0.93');
  });

  it('renders found and not found ideas in the Qloo off comparison', () => {
    const html = compareHtml({ plain: [
      { gift: 'A book', name: 'North Wind', kind: 'book', found: true, affinity: 0.876 },
      { gift: 'A mug', name: 'Tea Time', kind: 'brand', found: false },
    ], qloo_mean: 0.91, plain_mean: 0.78, not_found: 1 });
    expect(html).toContain('<h3>Qloo off: the plain model&#39;s picks</h3>');
    expect(html).toContain('A book');
    expect(html).toContain('North Wind');
    expect(html).toContain('aria-label="Qloo affinity 0.88 of 1"');
    expect(html).toContain('A mug');
    expect(html).toContain('Tea Time');
    expect(html).toContain('not found in Qloo');
  });

  it('says none found in Qloo when the plain mean is null', () => {
    const html = compareHtml({ plain: [{ gift: 'A gift', name: 'Unknown', kind: 'brand', found: false }], qloo_mean: 0.91, plain_mean: null, not_found: 1 });
    expect(html).toContain('Plain model: none found in Qloo.');
  });

  it('escapes every comparison idea text field', () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const html = compareHtml({ plain: [{ gift: hostile, name: hostile, kind: hostile, found: false }], qloo_mean: 0, plain_mean: null, not_found: 1 });
    expect(html).not.toContain('<img');
    expect(html.match(/&lt;img/g)).toHaveLength(2);
  });

  it('uses the comparison event numbers in the summary line', () => {
    const html = compareHtml({ plain: Array.from({ length: 6 }, (_, i) => ({ gift: `Gift ${i + 1}`, name: `Name ${i + 1}`, kind: 'book', found: i < 4, affinity: 0.78 })), qloo_mean: 0.91, plain_mean: 0.78, not_found: 2 });
    expect(html).toContain('Gift Scout&#39;s cards: mean affinity 0.91. Plain model: 0.78 over the 4 Qloo knows, 2 of 6 not found.');
  });

  it('explains affinity accessibly and names escaped seeds and entity in the title', () => {
    const html = cardHtml({ gift: 'Gift', why: 'Why', price_low: 1, price_high: 1, entity: { name: '<em>Entity</em>', affinity: 0.9307 }, seeds: ['<b>Seed</b>', 'Other'], from_call: 4 });
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Qloo affinity 0.93 of 1"');
    expect(html).toContain('affinity');
    expect(html).toContain('How strongly people who love &lt;b&gt;Seed&lt;/b&gt; and Other also love &lt;em&gt;Entity&lt;/em&gt;, on Qloo&#39;s 0 to 1 scale.');
  });

  it('shows Qloo shares on cards with largest remainder rounding, escaped names, and the tag seed after them', () => {
    const html = cardHtml({ gift: 'Gift', why: 'Why', price_low: 1, price_high: 1, entity: { name: 'Entity' },
      seeds: ['<b>Lagavulin</b>', 'John le Carré', 'Unshared entity', 'Korean'], tag_seeds: ['Korean'],
      seed_shares: [{ name: '<b>Lagavulin</b>', share: 0.333 }, { name: 'John le Carré', share: 0.333 }, { name: 'Other', share: 0.333 }], from_call: 1 });
    expect(html).toContain('&lt;b&gt;Lagavulin&lt;/b&gt; 34%, John le Carré 33%, Other 33%, Korean');
    expect(html).toContain('title="Qloo&#39;s own split of which favourite pulled this in."');
    expect(html).toContain('because-arrow');
  });

  it('shows the same split under panel results that have shares', () => {
    const html = callRowHtml({ t: 'call', n: 1, tool: 'taste_insights', args: {} }, {
      n: 1, tool: 'taste_insights', ok: true, ms: 1, cached: false, text: 'Done', top: [{ name: 'Gift', type: 'brand', shares: [
        { name: 'Lagavulin', share: 0.56 }, { name: 'John le Carré', share: 0.44 },
      ] }],
    });
    expect(html).toContain('<small class="result-shares">Lagavulin 56%, John le Carré 44%</small>');
  });

  it('summarizes Qloo calls and cached results', () => {
    expect(panelSummary([])).toBe('');
    expect(panelSummary([{ t: 'result', tool: 'search_entities', cached: false }])).toBe('1 Qloo call');
    expect(panelSummary([
      { t: 'result', tool: 'search_entities', cached: false },
      { t: 'result', tool: 'search_tags', cached: false },
      { t: 'result', tool: 'taste_insights', cached: false },
    ])).toBe('3 Qloo calls');
    expect(panelSummary([
      { t: 'result', tool: 'search_entities', cached: true },
      { t: 'result', tool: 'search_tags', cached: true },
      { t: 'result', tool: 'taste_insights', cached: false },
    ])).toBe('3 Qloo calls, 2 from the cache');
    expect(panelSummary([{ t: 'result', tool: 'buy_gift', cached: true }])).toBe('');
  });

  it('draws share weighted lines with percentage titles', () => {
    const svg = walkSvg([{ seeds: ['Lagavulin', 'John le Carré'], seed_shares: [
      { name: 'Lagavulin', share: 0.56 }, { name: 'John le Carré', share: 0.44 },
    ], entity: { name: 'Islay glass', affinity: 0.82 } }]);
    expect(svg).toContain('stroke-width="3.24" stroke-opacity="0.75" stroke-linecap="round"><title>Lagavulin 56%</title>');
    expect(svg).toContain('stroke-width="2.76" stroke-opacity="0.75" stroke-linecap="round"><title>John le Carré 44%</title>');
  });

  it('uses 1.5 px for lines when cards have no shares', () => {
    const svg = walkSvg([{ seeds: ['Lagavulin'], entity: { name: 'Islay glass' } }]);
    expect(svg).toContain('stroke-width="1.5" stroke-opacity="0.75" stroke-linecap="round"><title>Lagavulin</title>');
  });

  it('draws a tag seed without a share as a dashed 1 px line', () => {
    const svg = walkSvg([{ seeds: ['Lagavulin', 'Korean'], seed_shares: [
      { name: 'Lagavulin', share: 0.7 },
    ], tag_seeds: ['Korean'], entity: { name: 'Gift idea' } }]);
    expect(svg).toContain('stroke-width="1" stroke-opacity="0.75" stroke-linecap="round" stroke-dasharray="3 3"><title>Korean</title>');
  });

  it('ends lines at the left edge of numbered circles and draws solid circles over them', () => {
    const svg = walkSvg([
      { seeds: ['Lagavulin'], seed_shares: [{ name: 'Lagavulin', share: 1 }], entity: { name: 'One' } },
      { seeds: ['Lagavulin'], seed_shares: [{ name: 'Lagavulin', share: 1 }], entity: { name: 'Two' } },
    ]);
    const lines = [...svg.matchAll(/<line\b([^>]*)>/g)].map((match) => match[1]);
    const circles = [...svg.matchAll(/<circle\b([^>]*)>/g)].map((match) => Object.fromEntries([...match[1].matchAll(/([\w-]+)="([^"]+)"/g)].map((attr) => [attr[1], Number(attr[2])])));
    expect(lines).toHaveLength(2);
    expect(circles).toHaveLength(2);
    for (const attrs of lines) {
      const x2 = Number(attrs.match(/x2="([^"]+)"/)?.[1]);
      const y2 = Number(attrs.match(/y2="([^"]+)"/)?.[1]);
      expect(x2).toBe(circles[0].cx - circles[0].r);
      for (const circle of circles) {
        expect(Math.hypot(x2 - circle.cx, y2 - circle.cy)).toBeGreaterThanOrEqual(circle.r);
      }
    }
    expect([...svg.matchAll(/<circle\b([^>]*)\/>/g)].every((match) => /fill="var\(--walk-background\)"/.test(match[1]))).toBe(true);
  });

  it('keeps every walk element box inside its viewBox with top and bottom margins', () => {
    const cards = Array.from({ length: 6 }, (_, index) => ({
      seeds: index === 0 ? ['John le Carré'] : index === 5 ? ['Lagavulin'] : [],
      entity: { name: `Gift ${index + 1}`, affinity: 0.9 },
    }));
    const svg = walkSvg(cards);
    const [viewWidth, viewHeight] = [...svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/)].slice(1).map(Number);
    const margin = 3;
    const stroke = 1;
    const textSize = 11;
    const textWidth = (text: string) => Array.from(text).length * textSize * 0.58;
    const rowHeight = 38;
    const expectedHeight = Math.max(6, 6) * rowHeight + 48;
    expect(viewWidth).toBe(252);
    expect(viewHeight).toBe(expectedHeight);
    const fontSizes = [...svg.matchAll(/font-size="([\d.]+)"/g)].map((match) => Number(match[1]));
    expect(fontSizes.length).toBeGreaterThan(0);
    expect(fontSizes.every((size) => size === 11)).toBe(true);
    expect(viewWidth).toBeLessThanOrEqual(252);

    const boxes = [];
    for (const match of svg.matchAll(/<rect\b([^>]*)\/>/g)) {
      const a = Object.fromEntries([...match[1].matchAll(/([\w-]+)="([^"]+)"/g)].map((attr) => [attr[1], Number(attr[2])]));
      boxes.push([a.x - stroke / 2, a.y - stroke / 2, a.x + a.width + stroke / 2, a.y + a.height + stroke / 2]);
    }
    for (const match of svg.matchAll(/<circle\b([^>]*)\/>/g)) {
      const a = Object.fromEntries([...match[1].matchAll(/([\w-]+)="([^"]+)"/g)].map((attr) => [attr[1], Number(attr[2])]));
      boxes.push([a.cx - a.r - stroke / 2, a.cy - a.r - stroke / 2, a.cx + a.r + stroke / 2, a.cy + a.r + stroke / 2]);
    }
    for (const match of svg.matchAll(/<text\b([^>]*)>(.*?)<\/text>/g)) {
      const a = Object.fromEntries([...match[1].matchAll(/([\w-]+)="([^"]+)"/g)].map((attr) => [attr[1], attr[2]]));
      const text = match[2].replaceAll(/<[^>]+>/g, '').replaceAll(/&(?:amp|lt|gt|quot|#39);/g, 'x');
      const x = Number(a.x), y = Number(a.y), width = textWidth(text), size = Number(a['font-size']);
      const left = a['text-anchor'] === 'middle' ? x - width / 2 : a['text-anchor'] === 'end' ? x - width : x;
      boxes.push([left, y - size, left + width, y + size * 0.25]);
    }
    for (const match of svg.matchAll(/<line\b([^>]*)>/g)) {
      const a = Object.fromEntries([...match[1].matchAll(/([\w-]+)="([^"]+)"/g)].map((attr) => [attr[1], Number(attr[2])]));
      const halfStroke = a['stroke-width'] / 2;
      boxes.push([Math.min(a.x1, a.x2) - halfStroke, Math.min(a.y1, a.y2) - halfStroke, Math.max(a.x1, a.x2) + halfStroke, Math.max(a.y1, a.y2) + halfStroke]);
    }
    for (const [left, top, right, bottom] of boxes) {
      expect(left).toBeGreaterThanOrEqual(margin);
      expect(top).toBeGreaterThanOrEqual(margin);
      expect(right).toBeLessThanOrEqual(viewWidth - margin);
      expect(bottom).toBeLessThanOrEqual(viewHeight - margin);
    }
  });

  it('fits the full John le Carré favourite name in its box', () => {
    const svg = walkSvg([{ seeds: ['John le Carré'], entity: { name: 'Laphroaig', affinity: 0.93 } }]);
    expect(svg).toContain('<tspan x="11">John le</tspan><tspan x="11" dy="12">Carré</tspan>');
    expect(svg).toContain('<title>John le Carré</title>');
  });

  it('shows the four target result names whole without affinity score text', () => {
    const names = ['Laphroaig', 'Isle of Jura', 'Fallen Angel', 'Edinburgh'];
    const svg = walkSvg(names.map((name) => ({ seeds: ['Lagavulin'], entity: { name, affinity: 0.94 } })));
    const texts = [...svg.matchAll(/<text x="170"[^>]*>(.*?)<\/text>/g)].map((match) => match[1]);
    expect(texts).toEqual(names);
    expect(svg).not.toMatch(/>0\.94<\/text>/);
    expect(names.every((name) => svg.includes('<title>' + name + '</title>'))).toBe(true);
  });

  it('keeps a long result name title when the visible label must be shortened', () => {
    const name = 'The Infinite Jest by David Foster Wallace';
    const svg = walkSvg([{ seeds: ['Lagavulin'], entity: { name, affinity: 0.94 } }]);
    const text = svg.match(/<text x="170"[^>]*>(.*?)<\/text>/)?.[1];
    expect(text).toMatch(/…$/);
    expect(170 + Array.from(text).length * 11 * 0.58).toBeLessThanOrEqual(249);
    expect(svg).toContain('<title>' + name + '</title>');
  });

  it('wraps favourites only between words and keeps Lagavulin whole', () => {
    const svg = walkSvg([{ seeds: ['Lagavulin', 'John le Carré'], entity: { name: 'Islay glass' } }]);
    expect(svg).toContain('>Lagavulin</text>');
    expect(svg).toContain('<tspan x="11">John le</tspan><tspan x="11" dy="12">Carré</tspan>');
    expect(svg).toContain('<title>Lagavulin</title>');
  });

  it('ellipsizes a favourite word only when it exceeds the capped box and keeps its full title', () => {
    const name = 'ExtraordinarilyLongFavourite';
    const svg = walkSvg([{ seeds: [name], entity: { name: 'Gift' } }]);
    expect(svg).toContain('>Extraordina…</text>');
    expect(svg).toContain('<title>' + name + '</title>');
    expect(svg).toContain('width="96"');
  });

  it('keeps the line zone at least 30% of the favourite to circle span', () => {
    const svg = walkSvg([{ seeds: ['Lagavulin'], entity: { name: 'Islay glass', affinity: 0.82 } }]);
    const line = svg.match(/<line\b([^>]*)>/)?.[1] ?? '';
    const box = svg.match(/<rect\b([^>]*)\/>/)?.[1] ?? '';
    const circle = svg.match(/<circle\b([^>]*)\/>/)?.[1] ?? '';
    const x1 = Number(line.match(/x1="([\d.]+)"/)?.[1]);
    const x2 = Number(line.match(/x2="([\d.]+)"/)?.[1]);
    const boxX = Number(box.match(/x="([\d.]+)"/)?.[1]);
    const cx = Number(circle.match(/cx="([\d.]+)"/)?.[1]);
    const r = Number(circle.match(/r="([\d.]+)"/)?.[1]);
    const zone = x2 - x1;
    expect(zone / (cx - r - boxX)).toBeGreaterThanOrEqual(0.3);
  });

  it('escapes favourite and Qloo entity text in the SVG', () => {
    const hostile = '<svg onload="alert(1)">';
    const svg = walkSvg([{ seeds: [hostile], entity: { name: hostile } }]);
    expect(svg).not.toContain('<svg onload');
    expect(svg).toContain('&lt;svg onload=&quot;alert(1)&quot;&gt;');
  });

  it('labels the walk with the distinct favourite and gift idea counts', () => {
    const svg = walkSvg([
      { seeds: ['Lagavulin', 'Korean'], entity: { name: 'Glass' } },
      { seeds: ['Lagavulin'], entity: { name: 'Whisky stones' } },
    ]);
    expect(svg).toContain('aria-label="2 favourites lead to 2 gift ideas"');
  });

  it('describes each walk gift idea and its favourites with Qloo shares', () => {
    const svg = walkSvg([{ seeds: ['Lagavulin', 'John le CarrÃ©'], seed_shares: [
      { name: 'Lagavulin', share: 0.56 }, { name: 'John le CarrÃ©', share: 0.44 },
    ], entity: { name: 'Laphroaig' } }]);
    expect(svg).toContain('aria-describedby="walk-description"');
    expect(svg).toContain('<li>Laphroaig: from Lagavulin 56 percent and John le CarrÃ© 44 percent</li>');
  });

  it('returns an empty string for an empty cards list', () => {
    expect(walkSvg([])).toBe('');
  });

  it('has a valid one run fixture with known event types', async () => {
    const fs = await import('node:fs/promises');
    const content = await fs.readFile(new URL('../../public/dev/sample-run.ndjson', import.meta.url), 'utf8');
    const events = content.trim().split('\n').map((line) => JSON.parse(line));
    const known = new Set(['run', 'say', 'call', 'result', 'cards', 'usage', 'error', 'done']);
    expect(events[0].t).toBe('run');
    expect(events.at(-1).t).toBe('done');
    expect(events.every((event) => known.has(event.t))).toBe(true);
    expect(events.filter((event) => event.t === 'cards')[0].cards).toHaveLength(6);
  });
});
