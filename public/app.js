// The Gift Scout page: sends a message, reads the agent's events as they stream (NDJSON, see src/agent/events.ts), and
// draws the chat on the left and every Qloo call on the right. A conversation keeps its panel across turns.
import { cardHtml, callRowHtml, compareHtml, escapeHtml, orderBlockHtml, orderRowHtml, offerMessage, payCopy, quoteFor, paidRowHtml, panelSummary, refundFailedRowHtml, refundPendingRowHtml, refundRowHtml, shippedRowHtml, shippingProblem, plainLabels, plainName, walkSvg } from './render.js';

const $ = (selector) => document.querySelector(selector);
const chat = $('#chat-log');
const chatScroll = $('#chat-scroll');
const empty = $('#empty-state');
const panel = $('#scene-panel');
const callsList = $('#calls-list');
const panelEmpty = $('#panel-empty');
const runLabel = $('#run-label');
const panelSummaryLine = document.createElement('div');
panelSummaryLine.className = 'panel-summary';
panelSummaryLine.hidden = true;
runLabel.insertAdjacentElement('afterend', panelSummaryLine);
const walkPanel = document.createElement('div');
walkPanel.className = 'walk-panel';
walkPanel.hidden = true;
panelSummaryLine.insertAdjacentElement('afterend', walkPanel);
const usageBox = $('#usage');
const droppedWrap = $('#dropped-wrap');
const droppedList = $('#dropped-list');
const composer = $('#composer');
const input = $('#message');
const send = $('.send-button');
const examples = $('#examples');
const howButton = $('#how-button');
const howDialog = $('#how-dialog');

howButton.addEventListener('click', () => {
  if (howDialog.open) return;
  howDialog.showModal();
  $('#how-close').focus();
});
$('#how-close').addEventListener('click', () => howDialog.close());
howDialog.addEventListener('click', (event) => {
  if (event.target === howDialog) howDialog.close();
});
howDialog.addEventListener('close', () => howButton.focus());

/** The narrowing message the three recorded runs answer, so it also works when live scouting is resting. */
const NARROW_EXAMPLE = 'Make it cheaper, under 30 dollars.';

let conversation = null;
let busy = false;
let leavingForPayPal = false;
let restorePayPalButton = null;
window.addEventListener('pageshow', (event) => {
  if (!event.persisted || !leavingForPayPal) return;
  leavingForPayPal = false;
  busy = false;
  restorePayPalButton?.();
  restorePayPalButton = null;
  chat.querySelectorAll('.buy-button').forEach((button) => { button.disabled = false; });
});
const orders = new Map();
const cards = new Map();
let firstCardsReady = false;
let firstCardList = null;
let comparisonExists = false;
/** False on a share page: a shared conversation can be read, not bought from. */
let canBuy = true;
function ownerFor(id) {
  try { return sessionStorage.getItem(`gift-scout-owner:${id}`); } catch { return null; }
}
const calls = new Map();
const names = new Map();
let results = [];

function scrollChat() { chatScroll.scrollTop = chatScroll.scrollHeight; }

function addLine(className, text) {
  const el = document.createElement('div');
  el.className = className;
  el.textContent = text;
  chat.append(el);
  scrollChat();
  return el;
}

function openPanel(n) {
  panel.classList.add('open');
  panelTrigger.setAttribute('aria-expanded', 'true');
  syncPanelAvailability();
  if (phonePanel.matches) sheetClose.focus();
  if (!n) return;
  requestAnimationFrame(() => {
    const row = callsList.querySelector(`[data-call-row="${CSS.escape(String(n))}"]`);
    if (!row) return;
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    row.classList.add('highlight');
    setTimeout(() => row.classList.remove('highlight'), 1500);
  });
}

function drawCall(n) {
  const entry = calls.get(n);
  const holder = document.createElement('div');
  holder.innerHTML = callRowHtml(entry.call, entry.result, Object.fromEntries(names));
  const row = holder.firstElementChild;
  const old = callsList.querySelector(`[data-call-row="${CSS.escape(String(n))}"]`);
  if (old) old.replaceWith(row); else callsList.append(row);
  panelEmpty.hidden = true;
}

/** A fresh conversation starts with an empty panel. */
function resetPanel() {
  calls.clear();
  names.clear();
  results = [];
  panelSummaryLine.textContent = '';
  panelSummaryLine.hidden = true;
  walkPanel.replaceChildren();
  walkPanel.hidden = true;
  callsList.replaceChildren(panelEmpty);
  panelEmpty.hidden = false;
  droppedList.replaceChildren();
  droppedWrap.hidden = true;
  usageBox.replaceChildren();
  usageBox.hidden = true;
}

function modeText(event) {
  if (event.mode === 'cache') return 'Cached answer, no new Qloo calls';
  if (event.mode === 'replay') return `Recorded run${event.recorded_at ? ', ' + new Date(event.recorded_at).toLocaleDateString() : ''}`;
  if (event.mode === 'off') return 'Live scouting is resting';
  return 'Live';
}

function turnMark(turn) {
  if (typeof turn === 'number' && turn < 2) return;
  const mark = document.createElement('p');
  mark.className = 'turn-mark';
  mark.textContent = typeof turn === 'number' ? `Turn ${turn}` : turn;
  callsList.append(mark);
}

/** After a refinement, every earlier card set moves into one closed "Earlier ideas" box, so the current cards come first. */
function collapseEarlier() {
  const lists = [...chat.querySelectorAll('.card-list')];
  if (!lists.length) return;
  let box = chat.querySelector('details.earlier-ideas');
  if (!box) {
    box = document.createElement('details');
    box.className = 'earlier-ideas';
    box.append(document.createElement('summary'));
  }
  for (const list of lists) {
    list.classList.add('earlier');
    list.querySelectorAll('.gift-card').forEach((card) => { card.classList.remove('is-selected'); delete card.dataset.cardIndex; });
    box.append(list);
  }
  chat.append(box);
  box.querySelector('summary').textContent = `Earlier ideas (${box.querySelectorAll('.gift-card').length})`;
}

function clearSelection() {
  delete walkPanel.dataset.selectedCard;
  walkPanel.querySelectorAll('.is-selected').forEach((el) => el.classList.remove('is-selected'));
  chat.querySelectorAll('.gift-card.is-selected').forEach((el) => el.classList.remove('is-selected'));
  callsList.querySelectorAll('.call-row.is-selected').forEach((el) => el.classList.remove('is-selected'));
}

/** Selecting a current card brings its graph links forward and fades the others. */
function selectCard(cardEl) {
  const index = cardEl?.dataset.cardIndex;
  if (!index || walkPanel.dataset.selectedCard === index) return;
  clearSelection();
  walkPanel.dataset.selectedCard = index;
  walkPanel.querySelectorAll(`[data-card="${CSS.escape(index)}"]`).forEach((el) => el.classList.add('is-selected'));
  cardEl.classList.add('is-selected');
  const call = cardEl.querySelector('.call-link')?.getAttribute('data-call');
  if (call) callsList.querySelector(`[data-call-row="${CSS.escape(call)}"]`)?.classList.add('is-selected');
}

/** One "Leave out" button per interest behind the current cards, for the owner of a live conversation only. */
function drawLeaveOut() {
  walkPanel.querySelector('.leave-out-row')?.remove();
  if (!canBuy || !ownerFor(conversation) || !cards.size) return;
  const seeds = [...new Set([...cards.values()].flatMap((card) => (Array.isArray(card.seeds) ? card.seeds : [])))];
  if (!seeds.length) return;
  const holder = document.createElement('div');
  holder.innerHTML = `<div class="leave-out-row" role="group" aria-label="Leave an interest out">${seeds
    .map((seed) => `<button type="button" class="leave-out" data-leave-out="${escapeHtml(seed)}">${escapeHtml(leaveOutLabel(seed))}</button>`).join('')}</div>`;
  walkPanel.append(holder.firstElementChild);
}

/** The words the person typed for a seed: the query of the lookup whose top result is that seed. */
function interestFor(seed) {
  for (const { call, result } of calls.values()) {
    if (!['search_entities', 'search_tags'].includes(call?.tool) || !result?.ok) continue;
    const query = typeof call.args?.query === 'string' ? call.args.query.trim() : '';
    if (query && result.top?.[0]?.name === seed) return query;
  }
  return seed;
}

function leaveOutLabel(seed) {
  const typed = interestFor(seed);
  return typed === seed ? `Leave out ${seed}` : `Leave out ${typed} (${seed})`;
}

/** After a turn takes an interest back: what was left out and which cards were withdrawn. */
function leaveOutResult(event, gifts) {
  const block = document.createElement('div');
  block.className = 'leave-out-result';
  block.textContent = `Left out ${(event.names || []).join(' and ')}.${gifts.length ? ` Withdrawn: ${gifts.join(', ')}.` : ''}`;
  chat.append(block);
  scrollChat();
}

function drawCards(event) {
  const svg = walkSvg(event.cards);
  walkPanel.innerHTML = svg;
  delete walkPanel.dataset.selectedCard;
  walkPanel.hidden = !svg;
  collapseEarlier();
  chat.querySelectorAll('.card-actions').forEach((el) => el.remove());
  cards.clear();
  const wrap = document.createElement('div');
  wrap.className = 'card-list';
  if (!firstCardsReady) firstCardList = wrap;
  event.cards.forEach((card, i) => {
    cards.set(card.id, structuredClone(card));
    const holder = document.createElement('div');
    holder.innerHTML = cardHtml(card, { buyable: canBuy && Boolean(ownerFor(conversation)) });
    const el = holder.firstElementChild;
    el.dataset.cardId = card.id;
    el.dataset.cardIndex = String(i + 1);
    el.style.setProperty('--index', i);
    wrap.append(el);
  });
  chat.append(wrap);
  if (!firstCardsReady) firstCardsReady = true;
  drawCompareButton();
  drawLeaveOut();
  for (const d of event.dropped || []) {
    const p = document.createElement('p');
    p.className = 'dropped-item';
    p.innerHTML = `<strong>${escapeHtml(d.gift)}</strong><span>${escapeHtml(d.reason)}</span>`;
    droppedList.append(p);
  }
  droppedWrap.hidden = !droppedList.children.length;
  scrollChat();
}

function drawCompareButton() {
  chat.querySelector('.compare-actions')?.remove();
  if (!firstCardsReady || comparisonExists || !canBuy || !ownerFor(conversation)) return;
  const actions = document.createElement('div');
  actions.className = 'compare-actions';
  actions.innerHTML = '<button type="button" class="buy-button quiet compare-button" data-compare>Compare with Qloo off</button>';
  const current = [...chat.querySelectorAll('.card-list')].filter((list) => !list.classList.contains('earlier')).at(-1);
  (current ?? firstCardList)?.after(actions);
}

function drawComparison(event) {
  comparisonExists = true;
  chat.querySelector('.compare-actions')?.remove();
  chat.querySelector('.compare-block')?.remove();
  const holder = document.createElement('div');
  holder.innerHTML = compareHtml(event);
  chat.append(holder.firstElementChild);
  scrollChat();
}

function drawNarrowBox() {
  chat.querySelector('.narrow-box')?.remove();
  const form = document.createElement('form');
  form.className = 'narrow-box';
  form.innerHTML = '<label class="sr-only" for="narrow-input">What should change?</label>'
    + '<input id="narrow-input" autocomplete="off" placeholder="Change something">'
    + '<button type="submit">Refine</button>'
    + `<button type="button" class="example-chip narrow-chip">${escapeHtml(NARROW_EXAMPLE)}</button>`;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const value = form.querySelector('input').value.trim();
    if (value) submitMessage(value);
  });
  form.querySelector('.narrow-chip').addEventListener('click', () => submitMessage(NARROW_EXAMPLE));
  chat.append(form);
}

/** A share button in the panel, and in live use one under the narrowing box too, where a phone can see it. */
function drawShare(share, { inChat = false } = {}) {
  const wire = (button) => {
    button.onclick = async () => {
      const url = location.origin + share;
      try { await navigator.clipboard.writeText(url); } catch { window.prompt('Share link', url); }
      button.textContent = 'Link copied';
      setTimeout(() => { button.textContent = 'Copy share link'; }, 1800);
    };
  };
  const make = (extra) => {
    const button = document.createElement('button');
    button.className = 'share-button' + extra;
    button.type = 'button';
    button.textContent = 'Copy share link';
    return button;
  };
  let inPanel = usageBox.querySelector('.share-button');
  if (!inPanel) { inPanel = make(''); usageBox.append(inPanel); }
  wire(inPanel);
  usageBox.hidden = false;
  chat.querySelector('.share-inline')?.remove();
  if (inChat) {
    const inline = make(' share-inline');
    wire(inline);
    chat.append(inline);
  }
}

function finishCard(card, text) {
  const escaped = CSS.escape(card);
  chat.querySelectorAll(`[data-pay][data-card="${escaped}"], [data-buy="${escaped}"], [data-resume="${escaped}"]`).forEach((button) => {
    const actions = button.closest('.card-actions');
    if (!actions) return;
    const note = document.createElement('p');
    note.className = 'pay-note paid-note';
    note.dataset.paidCard = card;
    note.textContent = text;
    actions.replaceWith(note);
  });
  chat.querySelectorAll(`[data-paid-card="${escaped}"]`).forEach((note) => { note.textContent = text; });
}

function updateOrder(event) {
  const card = event.card || [...orders.keys()].at(-1);
  if (!card) return;
  let order = orders.get(card);
  if (!order && event.t === 'paid') {
    const block = document.createElement('section');
    block.className = 'order-block';
    block.setAttribute('role', 'status');
    block.dataset.orderCard = card;
    const body = document.createElement('div');
    body.className = 'order-body';
    block.append(body);
    if (conversation && ownerFor(conversation)) {
      const actions = document.createElement('div');
      actions.className = 'order-actions';
      const refund = document.createElement('button');
      refund.type = 'button';
      refund.className = 'buy-button quiet refund-button';
      refund.dataset.refund = card;
      refund.textContent = 'Changed my mind';
      actions.append(refund);
      block.append(actions);
    }
    order = { block, body, gift: event.gift, amount: event.amount };
    orders.set(card, order);
    chat.append(block);
  }
  if (!order) return;
  order.status = event.t === 'refund_failed' ? (order.tracker ? 'shipped' : 'paid') : event.t;
  if (event.t === 'shipped') {
    order.shipTo = event.ship_to;
    order.tracker = event.tracking_number;
  }
  if (event.t === 'refunded') order.block.querySelector('.order-actions')?.remove();
  const refund = order.block.querySelector('[data-refund]');
  if (refund) {
    refund.textContent = order.status === 'refund_pending' ? 'Check refund' : 'Changed my mind';
    refund.disabled = false;
  }
  order.body.innerHTML = orderBlockHtml(order);
  if (['paid', 'refunded', 'refund_pending', 'refund_failed'].includes(event.t)) finishCard(card, event.t === 'refund_pending' ? 'Refund pending' : event.t === 'refunded' ? 'Refunded' : 'Paid');
  scrollChat();
}

function handleEvent(event, { live = true } = {}) {
  switch (event.t) {
    case 'run':
      if (event.turn === 1 && !['buy', 'compare'].includes(event.purpose)) {
        orders.clear();
        resetPanel();
        firstCardsReady = false;
        firstCardList = null;
        comparisonExists = false;
      }
      conversation = event.conversation || conversation;
      runLabel.hidden = false;
      runLabel.textContent = modeText(event);
      if (event.purpose === 'buy') turnMark('Buy');
      else if (event.purpose === 'compare') turnMark('Compare');
      else turnMark(event.turn);
      break;
    case 'owner':
      if (conversation && typeof event.token === 'string') {
        try { sessionStorage.setItem(`gift-scout-owner:${conversation}`, event.token); } catch {}
        canBuy = true;
      }
      drawCompareButton();
      break;
    case 'order': {
      const holder = document.createElement('div');
      holder.innerHTML = orderRowHtml(event);
      callsList.append(holder.firstElementChild);
      if (live && event.approve_url) {
        leavingForPayPal = true;
        addLine('say-line', `Taking you to PayPal (sandbox) to approve $${event.amount}.`);
        setTimeout(() => location.assign(event.approve_url), 900);
      }
      break;
    }
    case 'paid': {
      const holder = document.createElement('div');
      holder.innerHTML = paidRowHtml(event);
      callsList.append(holder.firstElementChild);
      updateOrder(event);
      break;
    }
    case 'shipped': {
      const holder = document.createElement('div');
      holder.innerHTML = shippedRowHtml(event);
      callsList.append(holder.firstElementChild);
      updateOrder(event);
      break;
    }
    case 'refund_pending':
    case 'refund_failed':
    case 'refunded': {
      const holder = document.createElement('div');
      holder.innerHTML = event.t === 'refund_pending' ? refundPendingRowHtml(event) : event.t === 'refund_failed' ? refundFailedRowHtml(event) : refundRowHtml(event);
      callsList.append(holder.firstElementChild);
      updateOrder(event);
      break;
    }
    case 'offer_changed':
    case 'offer_gone': {
      const card = cards.get(event.card);
      if (card) {
        if (event.t === 'offer_changed' && card.product) {
          card.product = event.product ? structuredClone(event.product) : { ...card.product, price: event.new_price, title: event.new_title ?? event.title };
        } else if (event.t === 'offer_gone') delete card.product;
        const product = chat.querySelector(`.gift-card[data-card-id="${CSS.escape(event.card)}"]`);
        if (event.t === 'offer_gone') product?.querySelector('.product-block')?.remove();
        else {
          const template = document.createElement('template');
          template.innerHTML = cardHtml(card);
          const block = template.content.querySelector('.product-block');
          if (block) product?.querySelector('.product-block')?.replaceWith(block);
        }
        const copy = payCopy(card);
        product?.querySelectorAll('[data-pay]').forEach(control => { control.textContent = copy[control.dataset.pay]; });
        const note = product?.querySelector('.pay-note');
        if (note) note.textContent = copy.note;
      }
      addLine('say-line', offerMessage(event));
      break;
    }
    case 'say':
      if (chat.lastElementChild?.classList.contains('leave-out-result') && /^(Dropped what came from|Nothing shown came from) /.test(event.text)) break;
      addLine('say-line', plainName(event.text));
      break;
    case 'call':
      calls.set(event.n, { call: event, result: null });
      drawCall(event.n);
      break;
    case 'result': {
      results.push(event);
      for (const item of Array.isArray(event.top) ? event.top : []) {
        if (item?.id && item.name) names.set(item.id, item.name);
      }
      panelSummaryLine.textContent = panelSummary(results);
      panelSummaryLine.hidden = !panelSummaryLine.textContent;
      const entry = calls.get(event.n) || { call: { n: event.n, tool: event.tool, args: {} }, result: null };
      entry.result = event;
      calls.set(event.n, entry);
      drawCall(event.n);
      break;
    }
    case 'cards_withdrawn': {
      leaveOutResult(event, event.cards.map((id) => cards.get(id)?.gift).filter(Boolean));
      for (const id of event.cards) {
        cards.delete(id);
        const card = chat.querySelector(`[data-card-id="${CSS.escape(id)}"]`);
        if (!card) continue;
        card.classList.add('withdrawn');
        card.querySelectorAll('.card-actions, .ship-form').forEach((el) => el.remove());
        if (!card.querySelector('.withdrawn-note')) {
          const note = document.createElement('p');
          note.className = 'withdrawn-note';
          note.textContent = 'Taken back';
          card.append(note);
        }
      }
      const svg = walkSvg([...cards.values()]);
      walkPanel.innerHTML = svg;
      delete walkPanel.dataset.selectedCard;
      walkPanel.hidden = !svg;
      drawLeaveOut();
      break;
    }
    case 'cards':
      if (event.cards.length) drawCards(event);
      else {
        chat.querySelectorAll('.card-list').forEach((list) => list.classList.add('earlier'));
        chat.querySelectorAll('.card-actions').forEach((el) => el.remove());
        cards.clear();
        walkPanel.replaceChildren();
        walkPanel.hidden = true;
        addLine('say-line', 'No new ideas this time. Ask again with other things they love.');
      }
      break;
    case 'compare':
      drawComparison(event);
      break;
    case 'usage': {
      const line = document.createElement('p');
      line.className = 'usage-line';
      line.textContent = `${event.model_calls} model calls, ${event.neurons} neurons`;
      usageBox.prepend(line);
      usageBox.hidden = false;
      break;
    }
    case 'error':
      addLine('error-line', event.text);
      break;
    case 'done':
      if (live) drawNarrowBox();
      drawShare(event.share, { inChat: live });
      break;
  }
}

async function submitMessage(message) {
  const text = message.trim();
  if (!text || busy) return;
  busy = true;
  empty.hidden = true;
  examples.hidden = true;
  chat.querySelector('.narrow-box')?.remove();
  chat.querySelector('.share-inline')?.remove();
  addLine('user-message', text);
  input.value = '';
  send.disabled = true;
  send.querySelector('span').textContent = 'Looking';
  try {
    const response = await fetch('/api/scout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, ...(conversation && ownerFor(conversation) ? { conversation, owner: ownerFor(conversation) } : {}) }),
    });
    if (!response.ok || !response.body) {
      const why = await response.json().catch(() => ({}));
      throw new Error(why.error || 'The scout could not start. Try again in a minute.');
    }
    await readEvents(response);
  } catch (error) {
    addLine('error-line', error instanceof Error ? error.message : 'Something broke. Try again in a minute.');
  } finally {
    busy = false;
    send.disabled = false;
    send.querySelector('span').textContent = 'Find a gift';
    walkPanel.querySelectorAll('.leave-out').forEach((button) => { button.disabled = false; });
  }
}

/** The ship to fields under a card's pay buttons, or an error line naming what is missing. */
function readShipping(actions) {
  const form = actions?.querySelector('.ship-form');
  if (!form) return { ship: undefined };
  const value = (name) => form.querySelector(`[name="${name}"]`).value.trim();
  const ship = { name: value('ship-name'), line1: value('ship-line1'), city: value('ship-city'), state: value('ship-state').toUpperCase(), postal: value('ship-postal') };
  return { ship, error: shippingProblem(ship) };
}

function clearFieldError(input) {
  input.removeAttribute('aria-invalid');
  input.closest('.ship-field')?.querySelector('.field-error')?.remove();
}

async function buyCard(cardId, method, actions, button) {
  if (busy || !conversation) return;
  actions?.querySelectorAll('.ship-form input').forEach(clearFieldError);
  const { ship, error } = readShipping(actions);
  if (error) {
    const input = actions.querySelector(`[name="${CSS.escape(error.field)}"]`);
    input.setAttribute('aria-invalid', 'true');
    const line = document.createElement('p');
    line.className = 'error-line field-error';
    line.setAttribute('role', 'alert');
    line.textContent = error.text;
    input.closest('.ship-field').append(line);
    input.focus();
    return;
  }
  const card = cards.get(cardId);
  if (!card) return;
  const payment = card.product
    ? { offer: { id: card.product.id, price: card.product.price, title: card.product.title, url: card.product.url } }
    : { quote: quoteFor(card) };
  busy = true;
  const words = button.textContent;
  if (method === 'paypal') restorePayPalButton = () => {
    button.textContent = words;
    button.removeAttribute('aria-busy');
  };
  button.textContent = button.dataset.resume ? 'Checking payment' : method === 'card' ? 'Paying' : 'Going to PayPal';
  button.setAttribute('aria-busy', 'true');
  chat.querySelectorAll('.buy-button').forEach((b) => { b.disabled = true; });
  try {
    const response = await fetch('/api/buy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payment, conversation, card: cardId, method, owner: ownerFor(conversation), ...(ship ? { ship } : {}) }),
    });
    if (!response.ok || !response.body) throw new Error('We could not confirm the payment. Tap Pay again to check, or check PayPal.');
    await readEvents(response);
  } catch (error) {
    addLine('error-line', 'We could not confirm the payment. Tap Pay again to check, or check PayPal.');
  } finally {
    if (!leavingForPayPal) {
      busy = false;
      button.textContent = button.dataset.resume ? words : cards.has(cardId) ? payCopy(cards.get(cardId))[method] : words;
      button.removeAttribute('aria-busy');
      chat.querySelectorAll('.buy-button').forEach((b) => { b.disabled = false; });
    }
  }
}

/** "Changed my mind": a full refund of the paid gift. No model call; only the tab that bought it can ask. */
async function refundCard(button) {
  if (busy || !conversation) return;
  busy = true;
  button.disabled = true;
  const previousText = button.textContent;
  button.textContent = previousText === 'Check refund' ? 'Checking refund' : 'Refunding';
  try {
    const response = await fetch('/api/refund', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversation, card: button.dataset.refund, owner: ownerFor(conversation) }),
    });
    const out = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(out.error || 'PayPal did not answer. Tap again to check; it will not refund twice.');
    if (out.event) handleEvent(out.event);
    if (out.error) addLine('error-line', out.error);
    if (!out.event && response.status !== 202) throw new Error('PayPal did not confirm the refund. Check PayPal.');
  } catch (error) {
    addLine('error-line', error instanceof Error ? error.message : 'PayPal did not answer. Tap again to check; it will not refund twice.');
    button.disabled = false;
    button.textContent = previousText;
  } finally {
    button.disabled = false;
    if (button.textContent === 'Checking refund' || button.textContent === 'Refunding') button.textContent = previousText;
    busy = false;
  }
}

async function compareWithQlooOff(button) {
  if (busy || !conversation || !ownerFor(conversation) || comparisonExists) return;
  busy = true;
  const previousText = button.textContent;
  button.disabled = true;
  button.textContent = 'Comparing';
  try {
    const response = await fetch('/api/compare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversation, owner: ownerFor(conversation) }),
    });
    if (!response.ok || !response.body) {
      const why = await response.json().catch(() => ({}));
      throw new Error(why.error || (response.status === 403 ? 'Only the conversation owner can compare.' : 'The comparison could not start.'));
    }
    await readEvents(response);
    if (!comparisonExists) {
      button.disabled = false;
      button.textContent = previousText;
    }
  } catch (error) {
    addLine('error-line', error instanceof Error ? error.message : 'The comparison could not start.');
    button.disabled = false;
    button.textContent = 'Compare with Qloo off';
  } finally {
    busy = false;
  }
}

/** The tap on "Buy this one" opens the two ways to pay; nothing is bought until one is chosen. */
function showPayChoice(button) {
  const card = button.dataset.buy;
  const copy = payCopy(cards.get(card));
  const actions = button.closest('.card-actions');
  actions.classList.add('pay-choice');
  // A made up address fills the form so a judge can pay in one tap. Only the city and state are kept after the order.
  actions.innerHTML = '<p class="pay-note">PayPal sandbox, no real money.</p>'
    + '<fieldset class="ship-form"><legend>Ship to (any US address works in the sandbox)</legend>'
    + '<label class="ship-field ship-field-name"><span>Name</span><input name="ship-name" value="Sam Rivera" maxlength="60" autocomplete="off"></label>'
    + '<label class="ship-field ship-field-line1"><span>Street</span><input name="ship-line1" value="1 Main St" maxlength="100" autocomplete="off"></label>'
    + '<label class="ship-field ship-field-city"><span>City</span><input name="ship-city" value="San Jose" maxlength="60" autocomplete="off"></label>'
    + '<label class="ship-field ship-field-state"><span>State</span><input name="ship-state" value="CA" maxlength="2" autocomplete="off"></label>'
    + '<label class="ship-field ship-field-postal"><span>ZIP code</span><input name="ship-postal" value="95131" maxlength="5" inputmode="numeric" autocomplete="off"></label>'
    + '</fieldset>'
    + `<button type="button" class="buy-button" data-pay="paypal" data-card="${escapeHtml(card)}">${escapeHtml(copy.paypal)}</button>`
    + `<button type="button" class="buy-button quiet" data-pay="card" data-card="${escapeHtml(card)}">${escapeHtml(copy.card)}</button>`;
  actions.querySelector('.pay-note').textContent = copy.note;
  const firstPayButton = actions.querySelector('[data-pay="paypal"]');
  if (firstPayButton) {
    firstPayButton.focus();
    if (document.activeElement === firstPayButton) return;
  }
  actions.tabIndex = -1;
  actions.focus();
}

/** Reads an NDJSON stream of agent events and draws each as it comes. */
async function readEvents(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    let cut;
    while ((cut = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, cut).trim();
      buffer = buffer.slice(cut + 1);
      if (line) handleEvent(JSON.parse(line));
    }
    if (done) break;
  }
}

function drawPaymentRecovery(turns) {
  if (!conversation || !ownerFor(conversation)) return;
  const pending = new Map();
  const confirmed = new Set();
  for (const event of turns.flat()) {
    if (event.t === 'order') pending.set(event.card, event);
    if (['paid', 'shipped', 'refund_pending', 'refund_failed', 'refunded'].includes(event.t)) confirmed.add(event.card);
  }
  for (const event of pending.values()) {
    if (!cards.has(event.card) || confirmed.has(event.card)) continue;
    const actions = document.createElement('div');
    actions.className = 'card-actions payment-recovery';
    const note = document.createElement('p');
    note.className = 'pay-note';
    note.textContent = `Payment for ${event.gift} is not confirmed. Check the existing order.`;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'buy-button';
    button.dataset.resume = event.card;
    button.dataset.method = event.method === 'card' ? 'card' : 'paypal';
    button.textContent = event.approve_url ? 'Resume payment' : 'Check payment';
    actions.append(note);
    actions.append(button);
    chat.append(actions);
  }
}

async function loadShare(id) {
  canBuy = false;
  empty.hidden = true;
  examples.hidden = true;
  composer.hidden = true;
  try {
    const res = await fetch(`/api/conversation/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error('This link has expired or never existed.');
    const { turns } = await res.json();
    for (const events of turns || []) {
      for (const event of events) {
        if (event.t === 'run' && event.said) addLine('user-message', event.said);
        handleEvent(event, { live: false });
      }
    }
    drawPaymentRecovery(turns || []);
    const again = document.createElement('a');
    again.className = 'share-button start-own';
    again.href = '/';
    again.textContent = 'Find a gift of your own';
    chat.append(again);
  } catch (error) {
    addLine('error-line', error instanceof Error ? error.message : 'This link has expired or never existed.');
  }
}

async function loadFixture() {
  empty.hidden = true;
  const res = await fetch('/dev/sample-run.ndjson');
  if (!res.ok) return;
  for (const line of (await res.text()).split('\n').filter(Boolean)) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    handleEvent(JSON.parse(line));
  }
}

composer.addEventListener('submit', (e) => { e.preventDefault(); submitMessage(input.value); });
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitMessage(input.value); }
});
examples.addEventListener('click', (e) => {
  const chip = e.target.closest('[data-example]');
  if (chip) submitMessage(chip.dataset.example);
});
chat.addEventListener('click', (e) => {
  const resume = e.target.closest('[data-resume]');
  if (resume) { buyCard(resume.dataset.resume, resume.dataset.method, null, resume); return; }
  const compare = e.target.closest('[data-compare]');
  if (compare) { compareWithQlooOff(compare); return; }
  const pay = e.target.closest('[data-pay]');
  if (pay) { buyCard(pay.dataset.card, pay.dataset.pay, pay.closest('.card-actions'), pay); return; }
  const refund = e.target.closest('[data-refund]');
  if (refund) { refundCard(refund); return; }
  const buy = e.target.closest('[data-buy]');
  if (buy) { showPayChoice(buy); return; }
  const link = e.target.closest('[data-call]');
  if (link) { e.preventDefault(); selectCard(link.closest('.gift-card')); openPanel(link.dataset.call); return; }
  const picked = e.target.closest('.gift-card');
  if (picked && !e.target.closest('a, button, input, summary, label')) selectCard(picked);
});
chat.addEventListener('focusin', (e) => { selectCard(e.target.closest?.('.gift-card')); });
chat.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && walkPanel.dataset.selectedCard) clearSelection();
});
walkPanel.addEventListener('click', (e) => {
  const leave = e.target.closest('[data-leave-out]');
  if (!leave || busy) return;
  walkPanel.querySelectorAll('.leave-out').forEach((button) => { button.disabled = true; });
  submitMessage(`Drop ${interestFor(leave.dataset.leaveOut)}.`).finally(() => {
    walkPanel.querySelectorAll('.leave-out').forEach((button) => { button.disabled = false; });
  });
});
chat.addEventListener('input', (event) => {
  if (event.target.matches('.ship-form input')) clearFieldError(event.target);
});
const panelTrigger = $('#panel-trigger');
const sheetClose = $('#sheet-close');
const phonePanel = window.matchMedia('(max-width: 760px)');
const fallbackTabIndexes = new WeakMap();
function syncPanelAvailability() {
  const closedOnPhone = phonePanel.matches && !panel.classList.contains('open');
  if ('inert' in panel) {
    panel.inert = closedOnPhone;
    return;
  }
  panel.querySelectorAll('a[href], button, input, select, textarea, [tabindex]').forEach((control) => {
    if (closedOnPhone) {
      if (!fallbackTabIndexes.has(control)) fallbackTabIndexes.set(control, control.getAttribute('tabindex'));
      control.setAttribute('tabindex', '-1');
    } else if (fallbackTabIndexes.has(control)) {
      const oldTabIndex = fallbackTabIndexes.get(control);
      if (oldTabIndex === null) control.removeAttribute('tabindex');
      else control.setAttribute('tabindex', oldTabIndex);
      fallbackTabIndexes.delete(control);
    }
  });
}
syncPanelAvailability();
new MutationObserver(syncPanelAvailability).observe(panel, { childList: true, subtree: true });
if (phonePanel.addEventListener) phonePanel.addEventListener('change', syncPanelAvailability);
else phonePanel.addListener(syncPanelAvailability);

panelTrigger.addEventListener('click', () => {
  const open = panel.classList.toggle('open');
  panelTrigger.setAttribute('aria-expanded', String(open));
  syncPanelAvailability();
  if (open && phonePanel.matches) sheetClose.focus();
});
sheetClose.addEventListener('click', () => {
  panel.classList.remove('open');
  panelTrigger.setAttribute('aria-expanded', 'false');
  syncPanelAvailability();
  panelTrigger.focus();
});

/** Rewrites every text node and label that names Qloo, now and whenever the page changes. */
function usePlainLabels() {
  const relabel = () => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.nodeValue.includes('Qloo')) node.nodeValue = plainLabels(node.nodeValue);
    }
    for (const element of document.body.querySelectorAll('[aria-label*="Qloo"], [title*="Qloo"]')) {
      for (const name of ['aria-label', 'title']) {
        const value = element.getAttribute(name);
        if (value?.includes('Qloo')) element.setAttribute(name, plainLabels(value));
      }
    }
  };
  relabel();
  new MutationObserver(relabel).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['aria-label', 'title'] });
}

fetch('/api/examples')
  .then((r) => (r.ok ? r.json() : Promise.reject(new Error('no examples'))))
  .then((data) => {
    if (data.plain_labels) usePlainLabels();
    // With the live taste graph down (no key, a refused key, or Qloo's month spent), only the recorded examples run.
    const off = data.live === false
      ? '<p class="graph-off" role="status">The live taste graph is not available right now. These three examples still work from their recorded runs.</p>'
      : '';
    examples.innerHTML = off + (data.examples || []).slice(0, 3)
      .map((text) => `<button type="button" class="example-chip" data-example="${escapeHtml(text)}">${escapeHtml(text)}</button>`).join('');
  })
  .catch(() => {});

const shared = location.pathname.match(/^\/s\/([A-Za-z0-9_-]{6,48})\/?$/);
if (new URLSearchParams(location.search).has('fixture')) loadFixture();
else if (shared) loadShare(shared[1]);
