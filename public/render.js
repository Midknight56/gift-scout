export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function plainName(value) {
  return String(value ?? '').replace(/\s*\u2014\s*/g, ', ').replace(/\s*\u2013\s*/g, ' ')
    .replace(/(\p{L})-(?=\p{L})/gu, '$1 ').replace(/\s{2,}/g, ' ').trim();
}

export function shippingProblem(values) {
  for (const key of ['name', 'line1', 'city']) {
    if (!values[key]) return { field: `ship-${key}`, text: 'Add a name, a street and a city to ship to.' };
  }
  if (!/^[A-Z]{2}$/.test(values.state)) return { field: 'ship-state', text: 'Use the two letter state, like CA.' };
  if (!/^\d{5}$/.test(values.postal)) return { field: 'ship-postal', text: 'Use a five digit ZIP code.' };
  return null;
}

export function orderBlockHtml(order) {
  const refunded = order.status === 'refunded';
  const pending = order.status === 'refund_pending';
  const title = pending ? 'Refund pending' : refunded ? 'Refunded' : order.status === 'shipped' ? 'Paid, test tracker added' : 'Paid';
  const current = order.status === 'paid' ? 1 : 2;
  const steps = ['Ordered', 'Paid', pending ? 'Refund pending' : refunded ? 'Refunded' : 'Test tracker'].map((text, index) => {
    const attrs = index === current ? ' class="done now" aria-current="step"' : index < current ? ' class="done"' : '';
    return `<li${attrs}>${escapeHtml(text)}</li>`;
  }).join('');
  const fact = (label, value) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`;
  return '<p class="eyebrow">PayPal sandbox</p>'
    + `<h3 class="order-title">${escapeHtml(title)}</h3>`
    + `<p class="order-gift">${escapeHtml(order.gift)}</p>`
    + `<ol class="order-steps">${steps}</ol>`
    + '<p class="order-note">PayPal sandbox test. No store order is placed and nothing ships.</p>'
    + '<dl class="order-facts">'
    + fact('Amount', `$${order.amount}${pending ? ', refund pending' : refunded ? ' back' : ''}`)
    + (order.shipTo ? fact('Ship to', order.shipTo) : '')
    + (order.tracker ? fact('Test tracker', order.tracker) : '')
    + '</dl>';
}

/** With the plain labels switch on (the Worker's PLAIN_LABELS), page text says "the taste graph" in place of Qloo. */
export function plainLabels(text) {
  const before = String(text ?? '');
  const after = before
    .replace(/\bQloo's taste graph\b/g, 'the taste graph')
    .replace(/\b(\d+) Qloo knows\b/g, '$1 known to the taste graph')
    .replace(/\b(the|a|every|each|no|any|same|new|live|\d+) Qloo\b/gi, '$1 taste graph')
    .replace(/\bQloo affinity\b/g, 'taste graph affinity')
    .replace(/\bQloo's\b/g, "the taste graph's")
    .replace(/\bQloo\b/g, 'the taste graph')
    .replace(/([.!?:]\s+)the taste graph/g, '$1The taste graph');
  return /^Qloo/.test(before) ? after.charAt(0).toUpperCase() + after.slice(1) : after;
}

export function priceBand(low, high) {
  const a = Number(low), b = Number(high);
  const fmt = (n) => `$${Number.isFinite(n) ? n : 0}`;
  return a === b ? fmt(a) : `${fmt(a)} to ${fmt(b)}`;
}

function splitShares(shares) {
  const valid = (Array.isArray(shares) ? shares : []).map((item, index) => ({
    name: String(item?.name ?? ''), share: Number(item?.share), index,
  })).filter((item) => item.name && Number.isFinite(item.share) && item.share >= 0 && item.share <= 1);
  const total = valid.reduce((sum, item) => sum + item.share, 0);
  if (!valid.length || total <= 0) return [];
  const portions = valid.map((item) => {
    const exact = item.share / total * 100;
    return { ...item, value: Math.floor(exact), remainder: exact - Math.floor(exact) };
  });
  let left = 100 - portions.reduce((sum, item) => sum + item.value, 0);
  [...portions].sort((a, b) => b.remainder - a.remainder || a.index - b.index).slice(0, left).forEach((item) => { item.value++; });
  return portions.sort((a, b) => b.share - a.share || a.index - b.index).map(({ name, value }) => ({ name, value }));
}

/** `buyable` adds the "Buy this one" button: only on the latest cards of a live conversation, never on a share page. */
export function cardHtml(card, { buyable = false } = {}) {
  const gift = escapeHtml(card.gift);
  const why = escapeHtml(card.why);
  const activeSeeds = new Set(Array.isArray(card.seeds) ? card.seeds : []);
  const hasShares = Array.isArray(card.seed_shares);
  const percentages = splitShares(Array.isArray(card.seed_shares) ? card.seed_shares.filter((item) => activeSeeds.has(item?.name)) : []);
  const sharedNames = new Set(percentages.map((item) => item.name));
  const tagSeeds = hasShares && Array.isArray(card.tag_seeds)
    ? card.tag_seeds.filter((name) => activeSeeds.has(name)).map(plainName)
    : hasShares && Array.isArray(card.seeds) ? card.seeds.filter((name) => !sharedNames.has(name)).map(plainName) : [];
  const becauseSeeds = hasShares
    ? [...percentages.map((item) => `${plainName(item.name)} ${item.value}%`), ...tagSeeds].map(escapeHtml).join(', ')
    : escapeHtml(Array.isArray(card.seeds) ? card.seeds.map(plainName).join(' and ') : '');
  const entityName = plainName(card.entity?.name ?? '');
  const entity = escapeHtml(entityName);
  const affinity = Number.isFinite(Number(card.entity?.affinity)) ? Number(card.entity.affinity) : 0;
  const score = affinity.toFixed(2);
  const width = Math.max(0, Math.min(100, affinity * 100));
  const call = Number(card.from_call);
  const seedNames = Array.isArray(card.seeds) ? card.seeds.map(plainName).join(' and ') : '';
  const affinityTitle = hasShares
    ? "Qloo's own split of which favourite pulled this in."
    : `How strongly people who love ${seedNames} also love ${entityName}, on Qloo's 0 to 1 scale.`;
  let product = '';
  if (card.product) {
    const item = card.product;
    const safeUrl = (value) => { try { const url = new URL(value); return url.protocol === 'https:' ? url.href : ''; } catch { return ''; } };
    const image = safeUrl(item.image ?? '');
    const url = safeUrl(item.url ?? '');
    product = `<div class="product-block">${image ? `<img class="product-image" src="${escapeHtml(image)}" alt="${escapeHtml(plainName(item.title))}" width="64" height="64" loading="lazy">` : ''}<div class="product-details"><strong class="product-title">${escapeHtml(plainName(item.title))}</strong>${item.brand ? `<span class="product-brand">${escapeHtml(plainName(item.brand))}</span>` : ''}<span class="product-price">$${Number(item.price).toFixed(2)}</span>${url ? `<a class="product-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer nofollow">See it</a>` : ''}<span class="product-credit">Found by Channel3</span></div></div>`;
  }
  return `<article class="gift-card" style="--index:0"><div class="card-top"><h3 class="gift-name">${gift}</h3><span class="price">${priceBand(card.price_low, card.price_high)}</span></div><p class="gift-why">${why}</p>${product}<div class="because"><span class="because-seeds">${becauseSeeds}</span><span class="because-arrow" aria-hidden="true">→</span><span class="because-entity">${entity}</span><span class="affinity" role="img" aria-label="Qloo affinity ${score} of 1" title="${escapeHtml(affinityTitle)}"><span class="affinity-track"><span class="affinity-fill" style="width:${width}%"></span></span><span class="affinity-label">affinity</span><span>${score}</span></span><a class="call-link" href="#call-${Number.isFinite(call) ? call : 0}" data-call="${Number.isFinite(call) ? call : 0}">call ${Number.isFinite(call) ? call : 0}</a></div>${buyable ? `<div class="card-actions"><button type="button" class="buy-button" data-buy="${escapeHtml(card.id)}">Buy this one</button></div>` : ''}</article>`;
}

/** A short count of completed Qloo tool results in the current conversation. */
export function panelSummary(results) {
  const qlooTools = new Set(['search_entities', 'search_tags', 'taste_insights']);
  const qlooResults = (Array.isArray(results) ? results : []).filter((event) => event?.t === 'result' && qlooTools.has(event.tool));
  const count = qlooResults.length;
  const productCount = (Array.isArray(results) ? results : []).filter((event) => event?.t === 'result' && event.tool === 'search_products').length;
  if (!count && !productCount) return '';
  const cached = qlooResults.filter((event) => event.cached).length;
  return `${count} Qloo call${count === 1 ? '' : 's'}${cached ? `, ${cached} from the cache` : ''}${productCount ? `, ${productCount} product search${productCount === 1 ? '' : 'es'}` : ''}`;
}

/** A compact map from favourite seeds to the Qloo entities behind the latest cards event. */
export function walkSvg(cards) {
  const items = Array.isArray(cards) ? cards : [];
  if (!items.length) return '';

  const favourites = [];
  const favouriteIndex = new Map();
  for (const card of items) {
    for (const value of Array.isArray(card?.seeds) ? card.seeds : []) {
      const name = String(value ?? '');
      if (name && !favouriteIndex.has(name)) {
        favouriteIndex.set(name, favourites.length);
        favourites.push(name);
      }
    }
  }

  const width = 360;
  const fontSize = 14;
  const rowHeight = 60;
  const height = Math.max(1, Math.max(favourites.length, items.length)) * rowHeight + 64;
  const boxX = 4;
  const characterWidth = fontSize * 0.58;
  const boxWidth = Math.min(154, Math.max(86, ...favourites.map((name) => {
    const longestWord = plainName(name).split(/\s+/).filter(Boolean).reduce((longest, word) => Math.max(longest, Array.from(word).length), 0);
    return longestWord * characterWidth + 14;
  })));
  const boxHeight = 48;
  const circleX = 218;
  const circleRadius = 10;
  const resultX = circleX + circleRadius + 6;
  const rowY = (index, count) => 32 + (count > 1 ? index * (height - 64) / (count - 1) : (height - 64) / 2);
  const charsForWidth = (available) => Math.max(1, Math.floor(available / characterWidth));
  const shorten = (name, limit) => {
    const chars = Array.from(name);
    return chars.length > limit ? `${chars.slice(0, Math.max(0, limit - 1)).join('').trimEnd()}…` : name;
  };
  const wrapFavourite = (name) => {
    const limit = charsForWidth(boxWidth - 14);
    const rawWords = name.split(/\s+/).filter(Boolean);
    const words = (rawWords.length ? rawWords : [name]).map((word) => shorten(word, limit));
    const lines = [''];
    let omitted = false;
    for (const word of words) {
      const current = lines[lines.length - 1];
      const candidate = current ? `${current} ${word}` : word;
      if (Array.from(candidate).length <= limit) lines[lines.length - 1] = candidate;
      else if (lines.length < 2) lines.push(word);
      else { omitted = true; break; }
    }
    if (omitted) {
      let second = lines[1];
      while (second && Array.from(`${second} …`).length > limit) {
        second = second.split(' ').slice(0, -1).join(' ');
      }
      lines[1] = second ? `${second} …` : '…';
    }
    return lines.length === 2 ? lines : [lines[0]];
  };
  const lines = [];
  const favouriteRows = favourites.map((name, index) => ({ name, y: rowY(index, favourites.length) }));

  items.forEach((card, cardIndex) => {
    const y = rowY(cardIndex, items.length);
    const shares = new Map((Array.isArray(card?.seed_shares) ? card.seed_shares : [])
      .filter((entry) => entry && typeof entry.name === 'string' && Number.isFinite(Number(entry.share)) && Number(entry.share) >= 0 && Number(entry.share) <= 1)
      .map((entry) => [entry.name, Number(entry.share)]));
    const tagSeeds = new Set(Array.isArray(card?.tag_seeds) ? card.tag_seeds.map((name) => String(name ?? '')) : []);
    for (const seed of Array.isArray(card?.seeds) ? card.seeds : []) {
      const name = String(seed ?? '');
      const favourite = favouriteRows[favouriteIndex.get(name)];
      if (!favourite) continue;
      const hasShare = shares.has(name);
      const share = shares.get(name);
      const tag = !hasShare && tagSeeds.has(name);
      const strokeWidth = hasShare ? Math.max(1, Math.min(5, 1 + share * 4)) : tag ? 1 : 1.5;
      const title = plainName(hasShare ? `${name} ${Math.round(share * 100)}%` : name);
      lines.push(`<line x1="${boxX + boxWidth}" y1="${favourite.y}" x2="${circleX - circleRadius}" y2="${y}" stroke="${tag ? 'var(--muted)' : 'var(--accent)'}" stroke-width="${strokeWidth}" stroke-opacity="0.75" stroke-linecap="round"${tag ? ' stroke-dasharray="3 3"' : ''}><title>${escapeHtml(title)}</title></line>`);
    }
  });

  const favouriteBoxes = favouriteRows.map(({ name, y }) => {
    const wrapped = wrapFavourite(plainName(name));
    const text = wrapped.length === 1
      ? `<text x="${boxX + 7}" y="${y + 5}" fill="currentColor" font-size="${fontSize}">${escapeHtml(plainName(wrapped[0]))}</text>`
      : `<text x="${boxX + 7}" y="${y - 2}" fill="currentColor" font-size="${fontSize}"><tspan x="${boxX + 7}">${escapeHtml(plainName(wrapped[0]))}</tspan><tspan x="${boxX + 7}" dy="16">${escapeHtml(plainName(wrapped[1]))}</tspan></text>`;
    return `<g><rect x="${boxX}" y="${y - boxHeight / 2}" width="${boxWidth}" height="${boxHeight}" rx="7" fill="none" stroke="var(--hairline)"/>${text}<title>${escapeHtml(plainName(name))}</title></g>`;
  }).join('');
  const cardRows = items.map((card, index) => {
    const y = rowY(index, items.length);
    const name = plainName(card?.entity?.name ?? '');
    const nameLimit = charsForWidth(width - 3 - resultX);
    return `<g><circle cx="${circleX}" cy="${y}" r="${circleRadius}" fill="var(--walk-background)" stroke="var(--hairline)"/><text x="${circleX}" y="${y + 4}" text-anchor="middle" fill="currentColor" font-size="${fontSize}">${index + 1}</text><text x="${resultX}" y="${y + 4}" fill="currentColor" font-size="${fontSize}">${escapeHtml(shorten(name, nameLimit))}</text><title>${escapeHtml(name)}</title></g>`;
  }).join('');
  const label = `${favourites.length} ${favourites.length === 1 ? 'favourite' : 'favourites'} lead to ${items.length} gift ${items.length === 1 ? 'idea' : 'ideas'}`;
  const descriptions = items.map((card) => {
    const shares = new Map((Array.isArray(card?.seed_shares) ? card.seed_shares : [])
      .filter((entry) => entry && typeof entry.name === 'string' && Number.isFinite(Number(entry.share)) && Number(entry.share) >= 0 && Number(entry.share) <= 1)
      .map((entry) => [entry.name, Number(entry.share)]));
    const seeds = [...new Set((Array.isArray(card?.seeds) ? card.seeds : []).map((seed) => String(seed ?? '')).filter(Boolean))];
    const sources = seeds.map((seed) => `${plainName(seed)}${shares.has(seed) ? ` ${Math.round(shares.get(seed) * 100)} percent` : ''}`);
    return `<li>${escapeHtml(plainName(card?.entity?.name ?? 'Gift idea'))}: from ${escapeHtml(sources.join(' and ') || 'a favourite')}</li>`;
  }).join('');
  return `<div class="walk-description"><svg class="walk-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(label)}" aria-describedby="walk-description">${lines.join('')}${favouriteBoxes}${cardRows}</svg><ul class="sr-only" id="walk-description">${descriptions}</ul></div>`;
}

const tasteTypes = { brand: 'brands', book: 'books', podcast: 'podcasts', destination: 'trips', place: 'places', artist: 'artists', movie: 'films', tv_show: 'shows', person: 'people', video_game: 'games' };

/** A plain language line describing the request represented by a tool call. */
export function callSummary(callEvent, names = {}) {
  const tool = callEvent?.tool ?? '';
  const args = callEvent?.args ?? {};
  const quoted = (value) => `"${plainName(value)}"`;
  if (tool === 'check_offer') return `Check the current offer for ${quoted(args.title)}`;
  if (tool === 'search_products') return `Find ${quoted(args.query)} to buy, under $${args.max_price}`;
  if (tool === 'search_entities') return `Find ${quoted(args.query)} in Qloo${args.type ? ` as a ${args.type}` : ''}`;
  if (tool === 'search_tags') return `Find the tag for ${quoted(args.query)}`;
  if (tool === 'taste_insights') {
    const targetType = args.target_type ?? args.type;
    const seeds = [...(Array.isArray(args.seed_ids) ? args.seed_ids : []), ...(Array.isArray(args.seed_tags) ? args.seed_tags : [])]
      .map((id) => plainName(names[id] || 'a taste'));
    const audience = [];
    if (args.audience_gender) audience.push(String(args.audience_gender).replaceAll('_', ' '));
    if (args.audience_age) audience.push(String(args.audience_age).replaceAll('_', ' '));
    return `What fans of ${seeds.length ? seeds.join(' and ') : 'a taste'} love: ${tasteTypes[targetType] || targetType || 'things'}`
      + `${args.location ? ` in ${plainName(args.location)}` : ''}${audience.length ? ` (audience: ${audience.join(', ')})` : ''}`;
  }
  if (tool === 'buy_gift') {
    const amount = Number(args.amount_usd ?? args.amount);
    return `Buy card ${args.card_id ?? args.card ?? ''} for $${Number.isFinite(amount) ? amount.toFixed(2) : '0.00'}`;
  }
  return String(tool);
}

export function callRowHtml(callEvent, resultEvent, names = {}) {
  const n = Number(callEvent.n) || 0;
  const tool = escapeHtml(callEvent.tool);
  const args = escapeHtml(JSON.stringify(callEvent.args ?? {}, null, 2));
  const pending = !resultEvent;
  const ms = resultEvent && Number.isFinite(Number(resultEvent.ms)) ? `${Number(resultEvent.ms)} ms` : '';
  const badge = resultEvent?.cached ? '<span class="cached-badge">cached</span>' : '';
  let results = '';
  if (resultEvent) {
    const top = Array.isArray(resultEvent.top) ? resultEvent.top : [];
    results = top.length ? `<div class="result-list">${top.map((item) => {
      const affinity = Number.isFinite(Number(item.affinity)) ? Number(item.affinity) : null;
      const shares = splitShares(item.shares);
      const shareText = shares.length ? `<small class="result-shares">${shares.map(({ name, value }) => `${escapeHtml(plainName(name))} ${value}%`).join(', ')}</small>` : '';
      return `<div class="result-item"><div class="result-name">${escapeHtml(plainName(item.name))}<span class="result-type">${escapeHtml(item.type)}</span></div><span class="result-score">${affinity === null ? '' : affinity.toFixed(2)}</span>${affinity === null ? '' : `<div class="result-track"><span class="result-fill" style="width:${Math.max(0, Math.min(100, affinity * 100))}%"></span></div>`}${shareText}</div>`;
    }).join('')}</div>` : (callEvent.tool === 'buy_gift' ? '' : '<div class="no-results">Nothing came back</div>');
  }
  return `<article class="call-row" id="call-${n}" data-call-row="${n}"><div class="call-head"><span class="call-number">${n}</span><span class="call-tool">${tool}</span>${pending ? '<span class="call-wait" aria-label="Waiting"></span>' : `<span class="call-ms">${ms}</span>${badge}`}</div><div class="call-body"><p class="call-summary">${escapeHtml(callSummary(callEvent, names))}</p><details class="call-args"><summary>Arguments</summary><pre>${args}</pre></details>${resultEvent ? `${resultEvent.ok && resultEvent.top?.length ? '' : `<p class="result-status ${resultEvent.ok ? '' : 'failed'}">${escapeHtml(resultEvent.text || (resultEvent.ok ? 'Nothing found' : 'Could not complete'))}</p>`}${results}` : ''}</div></article>`;
}

/** The panel row of a PayPal sandbox order, and of its capture. */
export function orderRowHtml(event) {
  return `<article class="call-row pay-row" data-order="${escapeHtml(event.order_id)}"><div class="call-head"><span class="call-number">$</span><span class="call-tool">PayPal order</span><span class="call-ms">sandbox</span></div><div class="call-body"><p class="pay-line">${escapeHtml(event.product_title || event.gift)}</p><p class="pay-line">$${escapeHtml(event.amount)} USD, order ${escapeHtml(event.order_id)}</p><p class="pay-line">${event.method === 'card' ? 'Waiting for PayPal to confirm the payment' : 'Waiting for the buyer to approve at PayPal'}</p></div></article>`;
}

export function paidRowHtml(event) {
  const at = new Date(event.at);
  const when = Number.isNaN(at.getTime()) ? '' : at.toLocaleString();
  return `<article class="call-row pay-row paid" data-capture="${escapeHtml(event.capture_id)}"><div class="call-head"><span class="call-number">$</span><span class="call-tool">PayPal capture</span><span class="cached-badge">paid</span></div><div class="call-body"><p class="pay-line">${escapeHtml(event.product_title || event.gift)}</p><p class="pay-line">$${escapeHtml(event.amount)} USD, capture ${escapeHtml(event.capture_id)}</p><p class="pay-line">Order ${escapeHtml(event.order_id)}, ${escapeHtml(when)}</p></div></article>`;
}

/** The panel row of the PayPal tracker added after the capture. */
export function shippedRowHtml(event) {
  return `<article class="call-row pay-row shipped" data-tracker="${escapeHtml(event.tracker_id)}"><div class="call-head"><span class="call-number">$</span><span class="call-tool">PayPal tracker</span><span class="cached-badge">test</span></div><div class="call-body"><p class="pay-line">Test tracker${event.ship_to ? ` for ${escapeHtml(event.ship_to)}` : ''}. Nothing ships.</p><p class="pay-line">Tracking ${escapeHtml(event.tracking_number)}, capture ${escapeHtml(event.capture_id)}</p></div></article>`;
}

/** The panel row of a full refund. */
export function refundRowHtml(event) {
  return `<article class="call-row pay-row refunded" data-refund-row="${escapeHtml(event.refund_id)}"><div class="call-head"><span class="call-number">$</span><span class="call-tool">PayPal refund</span><span class="cached-badge">refunded</span></div><div class="call-body"><p class="pay-line">${escapeHtml(event.gift)}</p><p class="pay-line">$${escapeHtml(event.amount)} USD back, refund ${escapeHtml(event.refund_id)}</p><p class="pay-line">Capture ${escapeHtml(event.capture_id)}</p></div></article>`;
}

/** The plain model's gift ideas and how they score in Qloo. */
export function compareHtml(event) {
  const plain = Array.isArray(event?.plain) ? event.plain : [];
  const rows = plain.map((idea) => {
    const affinity = Number(idea?.affinity);
    const hasAffinity = idea?.found === true && Number.isFinite(affinity);
    const score = hasAffinity ? Math.max(0, Math.min(1, affinity)) : 0;
    const result = hasAffinity
      ? `<span class="affinity compare-affinity" role="img" aria-label="Qloo affinity ${score.toFixed(2)} of 1"><span class="affinity-track"><span class="affinity-fill" style="width:${score * 100}%"></span></span><span class="affinity-label">affinity</span><span>${score.toFixed(2)}</span></span>`
      : '<span class="compare-not-found">not found in Qloo</span>';
    const context = idea?.context === 'nearest' ? '<span class="compare-context">Scored on the nearest signals</span>' : '';
    const matchedName = plainName(idea?.matched?.name);
    const matched = idea?.found === true && matchedName && matchedName !== plainName(idea?.name)
      ? `<div class="compare-name">Matched: ${escapeHtml(matchedName)}</div>` : '';
    return `<li class="compare-item"><div class="compare-gift">${escapeHtml(plainName(idea?.gift))}</div><div class="compare-name">${escapeHtml(plainName(idea?.name))}</div>${matched}${result}${context}</li>`;
  }).join('');
  const knows = plain.filter((idea) => idea?.found === true).length;
  const notFound = Number.isFinite(Number(event?.not_found)) ? Number(event.not_found) : plain.length - knows;
  const qlooMean = Number.isFinite(Number(event?.qloo_mean)) ? Number(event.qloo_mean).toFixed(2) : '0.00';
  const plainSummary = event?.plain_mean == null || !Number.isFinite(Number(event.plain_mean))
    ? 'none found in Qloo'
    : `${Number(event.plain_mean).toFixed(2)} over the ${knows} Qloo knows, ${notFound} of ${plain.length} not found`;
  const coverage = event?.coverage;
  const counts = coverage && ['plain_found', 'plain_total', 'cards_scored', 'cards_total'].every((key) => Number.isInteger(coverage[key]) && coverage[key] >= 0);
  const coverageLine = counts
    ? `<p class="compare-coverage">Qloo knew ${coverage.plain_found} of the ${coverage.plain_total} plain ideas. ${coverage.cards_scored === coverage.cards_total ? `All ${coverage.cards_total} cards had a score.` : `${coverage.cards_scored} of the ${coverage.cards_total} cards had a score.`}</p>`
    : '';
  return `<section class="compare-block" aria-label="Qloo off comparison"><h3>Qloo off: the plain model&#39;s picks</h3><p>This compares taste graph affinity only. It does not show whether they would like the gift or how much time it saves.</p>${coverageLine}<ul class="compare-list">${rows}</ul><p class="compare-summary">Gift Scout&#39;s cards: mean affinity ${qlooMean}. Plain model: ${plainSummary}.</p></section>`;
}

export function refundPendingRowHtml(event) {
  return `<article class="call-row pay-row refund-pending" data-refund-row="${escapeHtml(event.refund_id)}"><div class="call-head"><span class="call-number">$</span><span class="call-tool">PayPal refund</span><span class="cached-badge">pending</span></div><div class="call-body"><p class="pay-line">${escapeHtml(event.gift)}</p><p class="pay-line">$${escapeHtml(event.amount)} USD, refund pending</p><p class="pay-line">Refund ${escapeHtml(event.refund_id)}</p><p class="pay-line">Capture ${escapeHtml(event.capture_id)}</p></div></article>`;
}

export function refundFailedRowHtml(event) {
  return `<article class="call-row pay-row refund-failed"><div class="call-head"><span class="call-number">$</span><span class="call-tool">PayPal refund</span><span class="cached-badge">failed</span></div><div class="call-body"><p class="pay-line">${escapeHtml(event.gift)}</p><p class="pay-line">PayPal did not complete the refund. The payment stands.</p><p class="pay-line">Refund ${escapeHtml(event.refund_id)}</p></div></article>`;
}

export function quoteFor(card) {
  return Math.min(Math.floor(card.price_high), Math.max(5, Math.ceil(card.price_low), Math.round((card.price_low + card.price_high) / 2)));
}

export function payCopy(card) {
  const price = Number(card?.product ? card.product.price : quoteFor(card)).toFixed(2);
  return {
    paypal: `Pay $${price} with PayPal`,
    card: `Pay $${price} with the test card`,
    note: card?.product ? `Paying for ${card.product.title}. PayPal sandbox, no real money.` : `A sandbox payment of $${price} for this idea. PayPal sandbox, no real money.`,
  };
}

export function offerMessage(event) {
  if (event.t === 'offer_changed' && event.changes?.some(change => change === 'title' || change === 'shop' || change === 'offer')) {
    return `This offer changed. It is now ${event.new_title ?? event.title} from ${event.shop} at $${Number(event.new_price).toFixed(2)}. Tap Pay again to pay for it.`;
  }
  return event.t === 'offer_changed'
    ? `The price is now $${Number(event.new_price).toFixed(2)}. Tap Pay again to pay $${Number(event.new_price).toFixed(2)}.`
    : event.reason === 'over_budget'
      ? `The price is now $${Number(event.new_price).toFixed(2)}, over the budget. The idea stays.`
    : 'That item is not on offer any more. The idea stays.';
}
