// Content script: finds the card list on Secret Lair product pages and adds prices.

(() => {
  const FOIL_ICON = '🌠';
  const DEFAULTS = { excludeUB: false, usd: true, eur: true };

  const CURRENCIES = {
    usd: { symbol: '$', nonfoil: ['usd'], foil: ['usd_foil', 'usd_etched'] },
    eur: { symbol: '€', nonfoil: ['eur'], foil: ['eur_foil', 'eur_etched'] },
  };

  let options = { ...DEFAULTS };
  // { pricesEl, qty, candidates, flavor, foil, group, card, sl, error }
  //   card: undefined = loading, null = not found
  //   sl:   the Secret Lair printing from this drop (or null if unknown)
  const entries = [];
  const groups = new Map(); // .product-information container -> totalEl

  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

  // ---------- styles ----------

  const style = document.createElement('style');
  style.textContent = `
    .scrylair-prices { font-size: 0.85em; opacity: 0.85; margin-top: 2px; }
    .scrylair-prices > div, .scrylair-total > div { white-space: nowrap; }
    .scrylair-prices a, .scrylair-total a { color: inherit; text-decoration: none; }
    .scrylair-prices a:hover { text-decoration: underline; }
    .scrylair-muted { opacity: 0.6; font-style: italic; }
    .scrylair-sl { opacity: 0.75; }
    .scrylair-li { margin-bottom: 0.5em; }
    .scrylair-total { margin-top: 0.75em; font-weight: bold; }
    .scrylair-total .scrylair-note { font-weight: normal; font-size: 0.85em; opacity: 0.7; }
  `;
  document.documentElement.appendChild(style);

  // ---------- parsing ----------

  // Leading treatment words: "Foil", "Non-Foil", "Rainbow Foil", "Etched Foil", "Reversible"...
  const TREATMENT = /^(?:(?:[\w-]+\s+){0,3}?(?:foil|non-?foil|etched)|reversible)\s+/i;

  // "1x Foil Timely Ward as “Rescue in the 13th Hour”"
  //   -> qty 1, candidates ["Timely Ward", "Foil Timely Ward"], flavor "Rescue in the 13th Hour", foil true
  function parseItem(text) {
    let t = text.replace(/\s+/g, ' ').trim();
    let qty = 1;
    const q = t.match(/^(\d+)\s*[x×]\s+/i);
    if (q) {
      qty = parseInt(q[1], 10);
      t = t.slice(q[0].length);
    }
    let flavor = null;
    const f = t.match(/\s+as\s+["“‘'](.*?)["”’']?$/i);
    if (f) {
      flavor = f[1];
      t = t.slice(0, f.index).trim();
    }

    // Most-stripped name first, falling back to less-stripped versions.
    const candidates = [t];
    let foil = false;
    let s = t;
    let m;
    while ((m = s.match(TREATMENT))) {
      if (/foil/i.test(m[0]) && !/non-?foil/i.test(m[0])) foil = true;
      s = s.slice(m[0].length);
      candidates.unshift(s);
    }
    return { qty, candidates, flavor, foil };
  }

  // ---------- pricing ----------

  function cheapest(printings, keys, respectUB = true) {
    let best = null;
    for (const p of printings) {
      if (respectUB && options.excludeUB && p.ub) continue;
      for (const k of keys) {
        if (p[k] == null) continue;
        const price = parseFloat(p[k]);
        if (!isNaN(price) && (!best || price < best.price)) best = { price, p };
      }
    }
    return best;
  }

  // Price of this drop's Secret Lair printing, in the finish the drop sells.
  function slPrice(e, c) {
    return e.sl ? cheapest([e.sl], e.foil ? c.foil : c.nonfoil, false) : null;
  }

  function fmt(symbol, n) {
    return symbol + n.toFixed(2);
  }

  function priceNode(symbol, best, isFoil) {
    const icon = isFoil ? FOIL_ICON + ' ' : '';
    if (!best) {
      const span = document.createElement('span');
      span.className = 'scrylair-muted';
      span.textContent = icon + '—';
      return span;
    }
    const a = document.createElement('a');
    a.href = best.p.uri;
    a.target = '_blank';
    a.rel = 'noopener';
    a.title = `${best.p.setName} #${best.p.num}`;
    a.textContent = icon + fmt(symbol, best.price);
    return a;
  }

  function enabledCurrencies() {
    return Object.keys(CURRENCIES).filter((c) => options[c]);
  }

  // ---------- Secret Lair printing detection ----------

  // 1. Match the "as “…”" name against Scryfall's flavor names.
  // 2. Otherwise use the SL printing released on the same date as the rest of
  //    the drop (most common release date among the page's cards' SL printings).
  function resolveSL(group) {
    const items = entries.filter((e) => e.group === group && e.card);
    const slOf = (e) => e.card.printings.filter((p) => p.sl);
    const votes = new Map();
    const vote = (d, w) => votes.set(d, (votes.get(d) || 0) + w);

    for (const e of items) {
      e.sl = null;
      const cands = slOf(e);
      if (e.flavor) {
        const m = cands.find((p) => p.flavors.some((f) => norm(f) === norm(e.flavor)));
        if (m) {
          e.sl = m;
          vote(m.released, 10);
          continue;
        }
      }
      for (const d of new Set(cands.map((p) => p.released))) vote(d, 1);
    }

    let date = null, best = 0;
    for (const [d, v] of votes) {
      if (v > best || (v === best && d > date)) { date = d; best = v; }
    }
    for (const e of items) {
      if (!e.sl) e.sl = slOf(e).find((p) => p.released === date) || null;
    }
  }

  // ---------- rendering ----------

  function muted(el, text) {
    const span = document.createElement('span');
    span.className = 'scrylair-muted';
    span.textContent = text;
    el.replaceChildren(span);
  }

  function renderEntry(e) {
    const el = e.pricesEl;
    if (e.error) return muted(el, 'Scryfall error: ' + e.error);
    if (e.card === undefined) return muted(el, 'Loading prices…');
    if (e.card === null) return muted(el, 'Not found on Scryfall');

    el.replaceChildren();
    for (const cur of enabledCurrencies()) {
      const c = CURRENCIES[cur];
      const line = document.createElement('div');
      line.append(
        priceNode(c.symbol, cheapest(e.card.printings, c.nonfoil), false),
        ' / ',
        priceNode(c.symbol, cheapest(e.card.printings, c.foil), true)
      );
      if (e.sl) {
        const sl = document.createElement('span');
        sl.className = 'scrylair-sl';
        sl.append(' · SL ', priceNode(c.symbol, slPrice(e, c), e.foil));
        line.appendChild(sl);
      }
      el.appendChild(line);
    }
  }

  function groupDone(group) {
    return entries.every((e) => e.group !== group || e.card !== undefined || e.error);
  }

  function renderTotal(group) {
    const totalEl = groups.get(group);
    const items = entries.filter((e) => e.group === group);
    totalEl.replaceChildren();
    if (!groupDone(group)) return;
    if (!items.some((e) => e.card)) return; // nothing found -> no total
    const curs = enabledCurrencies();
    if (!curs.length) return;

    const header = document.createElement('div');
    header.textContent = 'Total (cheapest printings):';
    totalEl.appendChild(header);

    const hasSL = items.some((e) => e.sl);
    const foilEdition = items.some((e) => e.foil);
    let anyMissing = false;
    const sum = (pick) => {
      let total = 0, found = 0, missing = false;
      for (const e of items) {
        const b = e.card ? pick(e) : null;
        if (b) { total += b.price * e.qty; found++; } else missing = true;
      }
      if (missing && found) anyMissing = true;
      return { total, found, missing };
    };
    const show = (sym, { total, found, missing }) =>
      found ? fmt(sym, total) + (missing ? '*' : '') : '—';

    for (const cur of curs) {
      const c = CURRENCIES[cur];
      let text =
        show(c.symbol, sum((e) => cheapest(e.card.printings, c.nonfoil))) +
        ` / ${FOIL_ICON} ` +
        show(c.symbol, sum((e) => cheapest(e.card.printings, c.foil)));
      if (hasSL) {
        text += ` · SL ${foilEdition ? FOIL_ICON + ' ' : ''}` + show(c.symbol, sum((e) => slPrice(e, c)));
      }
      const line = document.createElement('div');
      line.textContent = text;
      totalEl.appendChild(line);
    }
    if (anyMissing) {
      const note = document.createElement('div');
      note.className = 'scrylair-note';
      note.textContent = '* some cards have no price for this finish and are excluded';
      totalEl.appendChild(note);
    }
  }

  function renderGroup(group) {
    entries.forEach((e) => e.group === group && renderEntry(e));
    renderTotal(group);
  }

  function renderAll() {
    groups.forEach((_, group) => renderGroup(group));
  }

  // ---------- discovery ----------

  function isBundle() {
    const title = document.querySelector('h1.product-title')?.textContent || document.title;
    return /\bbundle\b/i.test(title);
  }

  // Group by the .product-information container, not by <ul>: some pages use a
  // single <ul> for all cards, others put each card in its own <ul>.
  function processContainer(container) {
    const uls = container.querySelectorAll('ul');
    if (!uls.length) return;
    container.dataset.scrylair = '1';

    const totalEl = document.createElement('div');
    totalEl.className = 'scrylair-total';
    uls[uls.length - 1].insertAdjacentElement('afterend', totalEl);
    groups.set(container, totalEl);

    for (const li of container.querySelectorAll('ul > li')) {
      const parsed = parseItem(li.textContent);
      if (!parsed.candidates[0]) continue;

      const nameEl = document.createElement('div');
      nameEl.className = 'scrylair-name';
      nameEl.append(...li.childNodes);
      const pricesEl = document.createElement('div');
      pricesEl.className = 'scrylair-prices';
      li.classList.add('scrylair-li');
      li.append(nameEl, pricesEl);

      const entry = { ...parsed, pricesEl, group: container, card: undefined, sl: null, error: null };
      entries.push(entry);
      renderEntry(entry);

      const done = () => {
        if (groupDone(container)) {
          resolveSL(container);
          renderGroup(container);
        } else {
          renderEntry(entry);
        }
      };
      chrome.runtime.sendMessage({ type: 'lookup', candidates: parsed.candidates }).then((res) => {
        if (res?.error) entry.error = res.error;
        else entry.card = res?.card ?? null;
        done();
      }).catch((err) => {
        entry.error = String(err.message || err);
        done();
      });
    }
    renderTotal(container);
  }

  function scan() {
    if (isBundle()) return;
    document.querySelectorAll('.product-information:not([data-scrylair])').forEach(processContainer);
  }

  // ---------- boot ----------

  chrome.storage.sync.get(DEFAULTS).then((o) => {
    options = o;
    scan();
    // Handle client-side navigation / late rendering.
    let pending = false;
    new MutationObserver(() => {
      if (pending) return;
      pending = true;
      setTimeout(() => { pending = false; scan(); }, 300);
    }).observe(document.body, { childList: true, subtree: true });
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    for (const [k, { newValue }] of Object.entries(changes)) options[k] = newValue;
    renderAll();
  });
})();
