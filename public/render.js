export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
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
  const hasShares = Array.isArray(card.seed_shares);
  const percentages = splitShares(card.seed_shares);
  const sharedNames = new Set(percentages.map((item) => item.name));
  const tagSeeds = hasShares && Array.isArray(card.tag_seeds)
    ? card.tag_seeds
    : hasShares && Array.isArray(card.seeds) ? card.seeds.filter((name) => !sharedNames.has(name)) : [];
  const becauseSeeds = hasShares
    ? [...percentages.map((item) => `${item.name} ${item.value}%`), ...tagSeeds].map(escapeHtml).join(', ')
    : escapeHtml(Array.isArray(card.seeds) ? card.seeds.join(' and ') : '');
  const entity = escapeHtml(card.entity?.name ?? '');
  const affinity = Number.isFinite(Number(card.entity?.affinity)) ? Number(card.entity.affinity) : 0;
  const score = affinity.toFixed(2);
  const width = Math.max(0, Math.min(100, affinity * 100));
  const call = Number(card.from_call);
  const seedNames = Array.isArray(card.seeds) ? card.seeds.join(' and ') : '';
  const affinityTitle = hasShares
    ? "Qloo's own split of which favourite pulled this in."
    : `How strongly people who love ${seedNames} also love ${card.entity?.name ?? ''}, on Qloo's 0 to 1 scale.`;
  let product = '';
  if (card.product) {
    const item = card.product;
    const safeUrl = (value) => { try { const url = new URL(value); return url.protocol === 'https:' ? url.href : ''; } catch { return ''; } };
    const image = safeUrl(item.image ?? '');
    const url = safeUrl(item.url ?? '');
    product = `<div class="product-block">${image ? `<img class="product-image" src="${escapeHtml(image)}" alt="${escapeHtml(item.title)}" width="64" height="64" loading="lazy">` : ''}<div class="product-details"><strong class="product-title">${escapeHtml(item.title)}</strong>${item.brand ? `<span class="product-brand">${escapeHtml(item.brand)}</span>` : ''}<span class="product-price">$${Number(item.price).toFixed(2)}</span>${url ? `<a class="product-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer nofollow">See it</a>` : ''}<span class="product-credit">Found by Channel3</span></div></div>`;
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

  const width = 252;
  const fontSize = 11;
  const rowHeight = 38;
  const height = Math.max(1, Math.max(favourites.length, items.length)) * rowHeight + 48;
  const boxX = 4;
  const characterWidth = fontSize * 0.58;
  const boxWidth = Math.min(96, Math.max(68, ...favourites.map((name) => {
    const longestWord = name.split(/\s+/).filter(Boolean).reduce((longest, word) => Math.max(longest, Array.from(word).length), 0);
    return longestWord * characterWidth + 14;
  })));
  const boxHeight = 34;
  const circleX = 154;
  const circleRadius = 10;
  const resultX = circleX + circleRadius + 6;
  const rowY = (index, count) => 24 + (count > 1 ? index * (height - 48) / (count - 1) : (height - 48) / 2);
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
      const title = hasShare ? `${name} ${Math.round(share * 100)}%` : name;
      lines.push(`<line x1="${boxX + boxWidth}" y1="${favourite.y}" x2="${circleX - circleRadius}" y2="${y}" stroke="${tag ? 'var(--muted)' : 'var(--accent)'}" stroke-width="${strokeWidth}" stroke-opacity="0.75" stroke-linecap="round"${tag ? ' stroke-dasharray="3 3"' : ''}><title>${escapeHtml(title)}</title></line>`);
    }
  });

  const favouriteBoxes = favouriteRows.map(({ name, y }) => {
    const wrapped = wrapFavourite(name);
    const text = wrapped.length === 1
      ? `<text x="${boxX + 7}" y="${y + 4}" fill="currentColor" font-size="${fontSize}">${escapeHtml(wrapped[0])}</text>`
      : `<text x="${boxX + 7}" y="${y - 2}" fill="currentColor" font-size="${fontSize}"><tspan x="${boxX + 7}">${escapeHtml(wrapped[0])}</tspan><tspan x="${boxX + 7}" dy="12">${escapeHtml(wrapped[1])}</tspan></text>`;
    return `<g><rect x="${boxX}" y="${y - boxHeight / 2}" width="${boxWidth}" height="${boxHeight}" rx="7" fill="none" stroke="var(--hairline)"/>${text}<title>${escapeHtml(name)}</title></g>`;
  }).join('');
  const cardRows = items.map((card, index) => {
    const y = rowY(index, items.length);
    const name = String(card?.entity?.name ?? '');
    const nameLimit = charsForWidth(width - 3 - resultX);
    return `<g><circle cx="${circleX}" cy="${y}" r="${circleRadius}" fill="var(--walk-background)" stroke="var(--hairline)"/><text x="${circleX}" y="${y + 4}" text-anchor="middle" fill="currentColor" font-size="${fontSize}">${index + 1}</text><text x="${resultX}" y="${y + 4}" fill="currentColor" font-size="${fontSize}">${escapeHtml(shorten(name, nameLimit))}</text><title>${escapeHtml(name)}</title></g>`;
  }).join('');
  const label = `${favourites.length} ${favourites.length === 1 ? 'favourite' : 'favourites'} lead to ${items.length} gift ${items.length === 1 ? 'idea' : 'ideas'}`;
  const descriptions = items.map((card) => {
    const shares = new Map((Array.isArray(card?.seed_shares) ? card.seed_shares : [])
      .filter((entry) => entry && typeof entry.name === 'string' && Number.isFinite(Number(entry.share)) && Number(entry.share) >= 0 && Number(entry.share) <= 1)
      .map((entry) => [entry.name, Number(entry.share)]));
    const seeds = [...new Set((Array.isArray(card?.seeds) ? card.seeds : []).map((seed) => String(seed ?? '')).filter(Boolean))];
    const sources = seeds.map((seed) => `${seed}${shares.has(seed) ? ` ${Math.round(shares.get(seed) * 100)} percent` : ''}`);
    return `<li>${escapeHtml(String(card?.entity?.name ?? 'Gift idea'))}: from ${escapeHtml(sources.join(' and ') || 'a favourite')}</li>`;
  }).join('');
  return `<div class="walk-description"><svg class="walk-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(label)}" aria-describedby="walk-description">${lines.join('')}${favouriteBoxes}${cardRows}</svg><ul class="sr-only" id="walk-description">${descriptions}</ul></div>`;
}

const tasteTypes = { brand: 'brands', book: 'books', podcast: 'podcasts', destination: 'trips', place: 'places', artist: 'artists', movie: 'films', tv_show: 'shows', person: 'people', video_game: 'games' };

/** A plain language line describing the request represented by a tool call. */
export function callSummary(callEvent, names = {}) {
  const tool = callEvent?.tool ?? '';
  const args = callEvent?.args ?? {};
  const quoted = (value) => `"${String(value ?? '')}"`;
  if (tool === 'search_products') return `Find ${quoted(args.query)} to buy, under $${args.max_price}`;
  if (tool === 'search_entities') return `Find ${quoted(args.query)} in Qloo${args.type ? ` as a ${args.type}` : ''}`;
  if (tool === 'search_tags') return `Find the tag for ${quoted(args.query)}`;
  if (tool === 'taste_insights') {
    const targetType = args.target_type ?? args.type;
    const seeds = [...(Array.isArray(args.seed_ids) ? args.seed_ids : []), ...(Array.isArray(args.seed_tags) ? args.seed_tags : [])]
      .map((id) => names[id] || 'a taste');
    const audience = [];
    if (args.audience_gender) audience.push(String(args.audience_gender).replaceAll('_', ' '));
    if (args.audience_age) audience.push(String(args.audience_age).replaceAll('_', ' '));
    return `What fans of ${seeds.length ? seeds.join(' and ') : 'a taste'} love: ${tasteTypes[targetType] || targetType || 'things'}`
      + `${args.location ? ` in ${args.location}` : ''}${audience.length ? ` (audience: ${audience.join(', ')})` : ''}`;
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
      const shareText = shares.length ? `<small class="result-shares">${shares.map(({ name, value }) => `${escapeHtml(name)} ${value}%`).join(', ')}</small>` : '';
      return `<div class="result-item"><div class="result-name">${escapeHtml(item.name)}<span class="result-type">${escapeHtml(item.type)}</span></div><span class="result-score">${affinity === null ? '' : affinity.toFixed(2)}</span>${affinity === null ? '' : `<div class="result-track"><span class="result-fill" style="width:${Math.max(0, Math.min(100, affinity * 100))}%"></span></div>`}${shareText}</div>`;
    }).join('')}</div>` : (callEvent.tool === 'buy_gift' ? '' : '<div class="no-results">Nothing came back</div>');
  }
  return `<article class="call-row" id="call-${n}" data-call-row="${n}"><div class="call-head"><span class="call-number">${n}</span><span class="call-tool">${tool}</span>${pending ? '<span class="call-wait" aria-label="Waiting"></span>' : `<span class="call-ms">${ms}</span>${badge}`}</div><div class="call-body"><p class="call-summary">${escapeHtml(callSummary(callEvent, names))}</p><pre class="call-args">${args}</pre>${resultEvent ? `${resultEvent.ok && resultEvent.top?.length ? '' : `<p class="result-status ${resultEvent.ok ? '' : 'failed'}">${escapeHtml(resultEvent.text || (resultEvent.ok ? 'Nothing found' : 'Could not complete'))}</p>`}${results}` : ''}</div></article>`;
}

/** The panel row of a PayPal sandbox order, and of its capture. */
export function orderRowHtml(event) {
  return `<article class="call-row pay-row" data-order="${escapeHtml(event.order_id)}"><div class="call-head"><span class="call-number">$</span><span class="call-tool">PayPal order</span><span class="call-ms">sandbox</span></div><div class="call-body"><p class="pay-line">${escapeHtml(event.product_title || event.gift)}</p><p class="pay-line">$${escapeHtml(event.amount)} USD, order ${escapeHtml(event.order_id)}</p><p class="pay-line">${event.method === 'card' ? 'Paid with PayPal\'s sandbox test card' : 'Waiting for the buyer to approve at PayPal'}</p></div></article>`;
}

export function paidRowHtml(event) {
  const at = new Date(event.at);
  const when = Number.isNaN(at.getTime()) ? '' : at.toLocaleString();
  return `<article class="call-row pay-row paid" data-capture="${escapeHtml(event.capture_id)}"><div class="call-head"><span class="call-number">$</span><span class="call-tool">PayPal capture</span><span class="cached-badge">paid</span></div><div class="call-body"><p class="pay-line">${escapeHtml(event.product_title || event.gift)}</p><p class="pay-line">$${escapeHtml(event.amount)} USD, capture ${escapeHtml(event.capture_id)}</p><p class="pay-line">Order ${escapeHtml(event.order_id)}, ${escapeHtml(when)}</p></div></article>`;
}

/** The panel row of the PayPal tracker added after the capture. */
export function shippedRowHtml(event) {
  return `<article class="call-row pay-row shipped" data-tracker="${escapeHtml(event.tracker_id)}"><div class="call-head"><span class="call-number">$</span><span class="call-tool">PayPal tracker</span><span class="cached-badge">shipped</span></div><div class="call-body"><p class="pay-line">On its way${event.ship_to ? ` to ${escapeHtml(event.ship_to)}` : ''}</p><p class="pay-line">Tracking ${escapeHtml(event.tracking_number)}, capture ${escapeHtml(event.capture_id)}</p></div></article>`;
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
    return `<li class="compare-item"><div class="compare-gift">${escapeHtml(idea?.gift)}</div><div class="compare-name">${escapeHtml(idea?.name)}</div>${result}</li>`;
  }).join('');
  const knows = plain.filter((idea) => idea?.found === true).length;
  const notFound = Number.isFinite(Number(event?.not_found)) ? Number(event.not_found) : plain.length - knows;
  const qlooMean = Number.isFinite(Number(event?.qloo_mean)) ? Number(event.qloo_mean).toFixed(2) : '0.00';
  const plainSummary = event?.plain_mean == null || !Number.isFinite(Number(event.plain_mean))
    ? 'none found in Qloo'
    : `${Number(event.plain_mean).toFixed(2)} over the ${knows} Qloo knows, ${notFound} of ${plain.length} not found`;
  return `<section class="compare-block" aria-label="Qloo off comparison"><h3>Qloo off: the plain model&#39;s picks</h3><ul class="compare-list">${rows}</ul><p class="compare-summary">Gift Scout&#39;s cards: mean affinity ${qlooMean}. Plain model: ${plainSummary}.</p></section>`;
}
