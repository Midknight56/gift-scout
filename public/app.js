// The Gift Scout page: sends a message, reads the agent's events as they stream (NDJSON, see src/agent/events.ts), and
// draws the chat on the left and every Qloo call on the right. A conversation keeps its panel across turns.
import { cardHtml, callRowHtml, compareHtml, escapeHtml, orderRowHtml, paidRowHtml, panelSummary, refundRowHtml, shippedRowHtml, walkSvg } from './render.js';

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

function drawCards(event) {
  const svg = walkSvg(event.cards);
  walkPanel.innerHTML = svg;
  walkPanel.hidden = !svg;
  chat.querySelectorAll('.card-list').forEach((list) => list.classList.add('earlier'));
  chat.querySelectorAll('.card-actions').forEach((el) => el.remove());
  const wrap = document.createElement('div');
  wrap.className = 'card-list';
  if (!firstCardsReady) firstCardList = wrap;
  event.cards.forEach((card, i) => {
    const holder = document.createElement('div');
    holder.innerHTML = cardHtml(card, { buyable: canBuy && Boolean(ownerFor(conversation)) });
    const el = holder.firstElementChild;
    el.style.setProperty('--index', i);
    wrap.append(el);
  });
  chat.append(wrap);
  if (!firstCardsReady) firstCardsReady = true;
  drawCompareButton();
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
  firstCardList?.after(actions);
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

function handleEvent(event, { live = true } = {}) {
  switch (event.t) {
    case 'run':
      if (event.turn === 1 && !['buy', 'compare'].includes(event.purpose)) {
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
      }
      drawCompareButton();
      break;
    case 'order': {
      const holder = document.createElement('div');
      holder.innerHTML = orderRowHtml(event);
      callsList.append(holder.firstElementChild);
      if (live && event.approve_url) {
        addLine('say-line', `Taking you to PayPal (sandbox) to approve $${event.amount}.`);
        setTimeout(() => location.assign(event.approve_url), 900);
      }
      break;
    }
    case 'paid': {
      const holder = document.createElement('div');
      holder.innerHTML = paidRowHtml(event);
      callsList.append(holder.firstElementChild);
      addLine('say-line', `Paid in the PayPal sandbox: $${event.amount} for ${event.gift}.`);
      // Only the tab that bought it may refund it; a share page opened anywhere else shows no button.
      if (conversation && ownerFor(conversation)) {
        const refund = document.createElement('button');
        refund.type = 'button';
        refund.className = 'buy-button quiet refund-button';
        refund.dataset.refund = event.card;
        refund.textContent = 'Changed my mind';
        chat.append(refund);
        scrollChat();
      }
      break;
    }
    case 'shipped': {
      const holder = document.createElement('div');
      holder.innerHTML = shippedRowHtml(event);
      callsList.append(holder.firstElementChild);
      addLine('say-line', `On its way${event.ship_to ? ` to ${event.ship_to}` : ''}. PayPal tracker ${event.tracking_number}.`);
      break;
    }
    case 'refunded': {
      const holder = document.createElement('div');
      holder.innerHTML = refundRowHtml(event);
      callsList.append(holder.firstElementChild);
      chat.querySelector(`[data-refund="${CSS.escape(event.card)}"]`)?.remove();
      addLine('say-line', `Refunded in the PayPal sandbox: $${event.amount} back for ${event.gift}.`);
      break;
    }
    case 'say':
      addLine('say-line', event.text);
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
    case 'cards':
      if (event.cards.length) drawCards(event);
      else {
        walkPanel.replaceChildren();
        walkPanel.hidden = true;
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
      body: JSON.stringify({ message: text, ...(conversation ? { conversation } : {}) }),
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
  }
}

/** The ship to fields under a card's pay buttons, or an error line naming what is missing. */
function readShipping(actions) {
  const form = actions?.querySelector('.ship-form');
  if (!form) return { ship: undefined };
  const value = (name) => form.querySelector(`[name="${name}"]`).value.trim();
  const ship = { name: value('ship-name'), line1: value('ship-line1'), city: value('ship-city'), state: value('ship-state').toUpperCase(), postal: value('ship-postal') };
  if (!ship.name || !ship.line1 || !ship.city) return { error: 'Add a name, a street and a city to ship to.' };
  if (!/^[A-Z]{2}$/.test(ship.state)) return { error: 'Use the two letter state, like CA.' };
  if (!/^\d{5}$/.test(ship.postal)) return { error: 'Use a five digit ZIP code.' };
  return { ship };
}

async function buyCard(cardId, method, actions) {
  if (busy || !conversation) return;
  const { ship, error } = readShipping(actions);
  if (error) { addLine('error-line', error); return; }
  busy = true;
  chat.querySelectorAll('.buy-button').forEach((b) => { b.disabled = true; });
  try {
    const response = await fetch('/api/buy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversation, card: cardId, method, owner: ownerFor(conversation), ...(ship ? { ship } : {}) }),
    });
    if (!response.ok || !response.body) throw new Error('The purchase could not start. Nothing was charged.');
    await readEvents(response);
  } catch (error) {
    addLine('error-line', error instanceof Error ? error.message : 'The purchase could not start. Nothing was charged.');
  } finally {
    busy = false;
    chat.querySelectorAll('.buy-button').forEach((b) => { b.disabled = false; });
  }
}

/** "Changed my mind": a full refund of the paid gift. No model call; only the tab that bought it can ask. */
async function refundCard(button) {
  if (busy || !conversation) return;
  busy = true;
  button.disabled = true;
  button.textContent = 'Refunding';
  try {
    const response = await fetch('/api/refund', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversation, card: button.dataset.refund, owner: ownerFor(conversation) }),
    });
    const out = await response.json().catch(() => ({}));
    if (!response.ok || !out.event) throw new Error(out.error || 'PayPal did not take the refund. Nothing changed.');
    handleEvent(out.event);
  } catch (error) {
    addLine('error-line', error instanceof Error ? error.message : 'PayPal did not take the refund. Nothing changed.');
    button.disabled = false;
    button.textContent = 'Changed my mind';
  } finally {
    busy = false;
  }
}

async function compareWithQlooOff(button) {
  if (busy || !conversation || !ownerFor(conversation) || comparisonExists) return;
  busy = true;
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
  const productTitle = button.closest('.gift-card').querySelector('.product-title')?.textContent;
  const actions = button.closest('.card-actions');
  actions.classList.add('pay-choice');
  // A made up address fills the form so a judge can pay in one tap. Only the city and state are kept after the order.
  actions.innerHTML = '<p class="pay-note">PayPal sandbox, no real money.</p>'
    + '<fieldset class="ship-form"><legend>Ship to (any US address works in the sandbox)</legend>'
    + '<input name="ship-name" aria-label="Name" value="Sam Rivera" maxlength="60" autocomplete="off">'
    + '<input name="ship-line1" aria-label="Street" value="1 Main St" maxlength="100" autocomplete="off">'
    + '<input name="ship-city" aria-label="City" value="San Jose" maxlength="60" autocomplete="off">'
    + '<input name="ship-state" aria-label="State" value="CA" maxlength="2" autocomplete="off">'
    + '<input name="ship-postal" aria-label="ZIP code" value="95131" maxlength="5" inputmode="numeric" autocomplete="off">'
    + '</fieldset>'
    + `<button type="button" class="buy-button" data-pay="paypal" data-card="${escapeHtml(card)}">Pay at PayPal</button>`
    + `<button type="button" class="buy-button quiet" data-pay="card" data-card="${escapeHtml(card)}">Pay with the test card</button>`;
  if (productTitle) actions.querySelector('.pay-note').textContent = `Paying for ${productTitle}. PayPal sandbox, no real money.`;
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
  const compare = e.target.closest('[data-compare]');
  if (compare) { compareWithQlooOff(compare); return; }
  const pay = e.target.closest('[data-pay]');
  if (pay) { buyCard(pay.dataset.card, pay.dataset.pay, pay.closest('.card-actions')); return; }
  const refund = e.target.closest('[data-refund]');
  if (refund) { refundCard(refund); return; }
  const buy = e.target.closest('[data-buy]');
  if (buy) { showPayChoice(buy); return; }
  const link = e.target.closest('[data-call]');
  if (link) { e.preventDefault(); openPanel(link.dataset.call); }
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

fetch('/api/examples')
  .then((r) => (r.ok ? r.json() : Promise.reject(new Error('no examples'))))
  .then((data) => {
    examples.innerHTML = (data.examples || []).slice(0, 3)
      .map((text) => `<button type="button" class="example-chip" data-example="${escapeHtml(text)}">${escapeHtml(text)}</button>`).join('');
  })
  .catch(() => {});

const shared = location.pathname.match(/^\/s\/([A-Za-z0-9_-]{6,48})\/?$/);
if (new URLSearchParams(location.search).has('fixture')) loadFixture();
else if (shared) loadShare(shared[1]);
