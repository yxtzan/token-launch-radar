// Token Radar dashboard: renders window.RADAR_DATA (written next to this page as ../data.js)
// into a filterable, sortable board with a per-protocol detail drawer. No network, no framework.
(function () {
  'use strict';

  var PAGE = 100;
  var root = document.getElementById('board');
  var D = window.RADAR_DATA;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

  if (!D || !Array.isArray(D.rows)) {
    root.appendChild(el('p', 'empty', 'Radar data failed to load.'));
    return;
  }

  var rows = D.rows;
  var state = { q: '', category: '', chain: '', watchlist: false, sort: 'implied', shown: PAGE };

  // ---------- formatting ----------
  function trimNum(x) {
    var s = x.toFixed(2);
    if (s.indexOf('.') !== -1) s = s.replace(/0+$/, '').replace(/\.$/, '');
    return s;
  }
  function money(v) {
    if (v === null || v === undefined || !isFinite(v)) return '—';
    if (Math.abs(v) >= 1e9) return '$' + trimNum(v / 1e9) + 'B';
    if (Math.abs(v) >= 1e6) return '$' + trimNum(v / 1e6) + 'M';
    if (Math.abs(v) >= 1e3) return '$' + trimNum(v / 1e3) + 'K';
    return '$' + Math.round(v);
  }
  function moneyFull(v) {
    var s = String(Math.round(v));
    var out = '';
    while (s.length > 3) { out = ',' + s.slice(-3) + out; s = s.slice(0, -3); }
    return '$' + s + out;
  }
  function pct(v) {
    if (v === null || v === undefined) return null;
    return (v >= 0 ? '+' : '') + v.toFixed(1) + '%';
  }
  function ageText(days) {
    if (days === null || days === undefined || days <= 0) return 'new';
    if (days < 365) return days + 'd';
    return (days / 365).toFixed(1) + 'y';
  }
  function factor(v) { return 'x' + Number(v).toFixed(4).replace(/0+$/, '').replace(/\.$/, '.0'); }

  // ---------- header ----------
  var header = el('header', 'top');
  var wm = el('div', 'wordmark');
  wm.appendChild(el('span', 'radar-dot'));
  wm.appendChild(el('span', null, 'TOKEN RADAR'));
  header.appendChild(wm);
  header.appendChild(el('p', 'tagline', 'Pre-token protocols ranked by implied value, from a sealed DefiLlama snapshot'));
  header.appendChild(el('p', 'asof', 'Snapshot as of ' + D.as_of + ' · TVL floor ' + money(D.floor_usd)));

  var covered = 0;
  rows.forEach(function (r) { if (r.watchlist) covered++; });
  var stats = el('div', 'stats');
  [
    ['Protocols scanned', D.stats.protocols],
    ['Pre-token tracked', D.stats.pre_token],
    ['Watchlist covered', covered + '/' + D.stats.watchlist],
    ['Total implied value', money(D.stats.total_implied_usd)]
  ].forEach(function (pair) {
    var chip = el('div', 'stat');
    chip.appendChild(el('span', null, pair[0]));
    chip.appendChild(el('b', null, pair[1]));
    stats.appendChild(chip);
  });
  header.appendChild(stats);
  root.appendChild(header);

  // ---------- methodology ----------
  var method = el('section', 'method');
  method.appendChild(el('h2', null, 'METHODOLOGY'));
  method.appendChild(el('p', null,
    'Implied value = TVL x the category multiple, adjusted. The multiple is the median market-cap/TVL ' +
    'ratio of already-tokenized peers in the same category, with every peer ratio winsorized at the global ' +
    '95th percentile (cap ' + Number(D.method.winsor_cap).toFixed(2) + 'x in this snapshot, global median ' +
    Number(D.method.global_median).toFixed(2) + 'x) so one thin-TVL outlier cannot inflate a category, then ' +
    'shrunk toward the global median with four phantom peers. The result is adjusted for 7-day TVL momentum, ' +
    'for years running without a token (maturity), and for chain footprint (scope).'));
  method.appendChild(el('p', null,
    'Farm plans are generated per protocol from its category, its chains and its TVL tier: each plan is a ' +
    'short sequence of concrete actions on the protocol itself, sized to what a small farmer would actually do.'));
  method.appendChild(el('p', 'note',
    'Implied value is this radar\u2019s own estimate from one snapshot, not a price prediction and not financial advice.'));
  root.appendChild(method);

  // ---------- controls ----------
  var controls = el('div', 'controls');
  var search = document.createElement('input');
  search.type = 'search';
  search.placeholder = 'Search name or slug\u2026';
  search.setAttribute('aria-label', 'Search by name or slug');
  controls.appendChild(search);

  function fillSelect(sel, values, allLabel) {
    var opt = document.createElement('option');
    opt.value = '';
    opt.textContent = allLabel;
    sel.appendChild(opt);
    values.forEach(function (v) {
      var o = document.createElement('option');
      o.value = v;
      o.textContent = v;
      sel.appendChild(o);
    });
  }
  var catSet = {}, chainSet = {};
  rows.forEach(function (r) {
    if (r.category !== null && r.category !== undefined) catSet[r.category] = true;
    (r.chains || []).forEach(function (c) { chainSet[c] = true; });
  });
  var catSel = document.createElement('select');
  catSel.setAttribute('aria-label', 'Filter by category');
  fillSelect(catSel, Object.keys(catSet).sort(), 'All categories');
  controls.appendChild(catSel);

  var chainSel = document.createElement('select');
  chainSel.setAttribute('aria-label', 'Filter by chain');
  fillSelect(chainSel, Object.keys(chainSet).sort(), 'All chains');
  controls.appendChild(chainSel);

  var wlLabel = el('label', 'wl');
  var wlBox = document.createElement('input');
  wlBox.type = 'checkbox';
  wlLabel.appendChild(wlBox);
  wlLabel.appendChild(el('span', null, 'Watchlist only'));
  controls.appendChild(wlLabel);

  var sortSel = document.createElement('select');
  sortSel.setAttribute('aria-label', 'Sort the board');
  [
    ['implied', 'Sort: Implied value'],
    ['tvl', 'Sort: TVL'],
    ['change', 'Sort: 7d change'],
    ['age', 'Sort: Age (oldest first)'],
    ['multiple', 'Sort: Category multiple']
  ].forEach(function (pair) {
    var o = document.createElement('option');
    o.value = pair[0];
    o.textContent = pair[1];
    sortSel.appendChild(o);
  });
  controls.appendChild(sortSel);
  root.appendChild(controls);

  var countLine = el('p', 'count');
  root.appendChild(countLine);

  // ---------- board ----------
  var wrap = el('div', 'table-wrap');
  var table = el('table', 'board');
  var thead = document.createElement('thead');
  var htr = document.createElement('tr');
  [['Rank', ''], ['Protocol', ''], ['Chains', ''], ['TVL', 'num'], ['7d', 'num'], ['Age', ''],
   ['Multiple', 'num'], ['Implied value', 'num'], ['Signals', ''], ['', '']]
    .forEach(function (pair) {
      htr.appendChild(el('th', pair[1], pair[0]));
    });
  thead.appendChild(htr);
  table.appendChild(thead);
  var tbody = document.createElement('tbody');
  table.appendChild(tbody);
  wrap.appendChild(table);
  root.appendChild(wrap);

  var moreRow = el('div', 'more-row');
  var moreBtn = el('button', 'more', 'Show more');
  moreRow.appendChild(moreBtn);
  root.appendChild(moreRow);

  var footer = el('footer', null,
    'Data is the sealed DefiLlama snapshot of ' + D.as_of + ' shipped with the bounty; no live prices; ' +
    'built for the make.fun token-radar-01 bounty.');
  root.appendChild(footer);

  // ---------- filtering + sorting ----------
  function currentRows() {
    var q = state.q.trim().toLowerCase();
    var out = rows.filter(function (r) {
      if (state.watchlist && !r.watchlist) return false;
      if (state.category && r.category !== state.category) return false;
      if (state.chain && (r.chains || []).indexOf(state.chain) === -1) return false;
      if (q && r.name.toLowerCase().indexOf(q) === -1 && r.slug.toLowerCase().indexOf(q) === -1) return false;
      return true;
    });
    var byRank = function (a, b) { return a.rank - b.rank; };
    var desc = function (key, nullsLast) {
      return function (a, b) {
        var av = a[key], bv = b[key];
        if (nullsLast) {
          if (av === null || av === undefined) return (bv === null || bv === undefined) ? byRank(a, b) : 1;
          if (bv === null || bv === undefined) return -1;
        }
        return bv !== av ? bv - av : byRank(a, b);
      };
    };
    if (state.sort === 'tvl') out.sort(desc('tvl_usd', false));
    else if (state.sort === 'change') out.sort(desc('change_7d', true));
    else if (state.sort === 'age') out.sort(desc('age_days', true));
    else if (state.sort === 'multiple') out.sort(desc('multiple', false));
    else out.sort(desc('implied_value_usd', false));
    return out;
  }

  function rowEl(r) {
    var tr = document.createElement('tr');
    if (r.rank <= 3) tr.className = 'podium';
    tr.appendChild(el('td', 'rank mono', '#' + r.rank));

    var proto = el('td', 'proto');
    var nameLine = el('div');
    nameLine.appendChild(el('span', 'name', r.name));
    if (r.watchlist) nameLine.appendChild(el('span', 'wl-badge', 'WL'));
    proto.appendChild(nameLine);
    proto.appendChild(el('div', 'cat', r.category === null || r.category === undefined ? 'Uncategorized' : r.category));
    tr.appendChild(proto);

    var chains = r.chains || [];
    var chainText = chains.length === 0 ? '—'
      : chains.length + ' · ' + chains.slice(0, 2).join(', ') + (chains.length > 2 ? ' +' + (chains.length - 2) : '');
    tr.appendChild(el('td', 'chains', chainText));

    tr.appendChild(el('td', 'num', money(r.tvl_usd)));

    var ch = pct(r.change_7d);
    var chTd = el('td', 'num ' + (ch === null ? 'flat' : r.change_7d >= 0 ? 'pos' : 'neg'), ch === null ? '—' : ch);
    tr.appendChild(chTd);

    tr.appendChild(el('td', null, ageText(r.age_days)));
    tr.appendChild(el('td', 'num', Number(r.multiple).toFixed(2) + 'x'));
    tr.appendChild(el('td', 'num implied', money(r.implied_value_usd)));

    var sig = el('td', 'signals');
    (r.signals || []).forEach(function (s) { sig.appendChild(el('span', 'chip', s)); });
    tr.appendChild(sig);

    var det = el('td');
    var btn = el('button', 'details', 'Details');
    btn.addEventListener('click', function () { openDetail(r); });
    det.appendChild(btn);
    tr.appendChild(det);

    tr.addEventListener('click', function () { openDetail(r); });
    return tr;
  }

  function render() {
    var list = currentRows();
    tbody.textContent = '';
    if (list.length === 0) {
      var tr = document.createElement('tr');
      var td = el('td', 'empty', 'No protocols match these filters.');
      td.colSpan = 10;
      tr.appendChild(td);
      tbody.appendChild(tr);
    } else {
      list.slice(0, state.shown).forEach(function (r) { tbody.appendChild(rowEl(r)); });
    }
    countLine.textContent = 'Showing ' + Math.min(state.shown, list.length) + ' of ' + list.length +
      (list.length !== rows.length ? ' matching · ' + rows.length + ' tracked' : '');
    moreBtn.style.display = list.length > state.shown ? '' : 'none';
    moreBtn.textContent = 'Show more (' + (list.length - state.shown) + ' remaining)';
  }

  function changed() { state.shown = PAGE; render(); }
  search.addEventListener('input', function () { state.q = search.value; changed(); });
  catSel.addEventListener('change', function () { state.category = catSel.value; changed(); });
  chainSel.addEventListener('change', function () { state.chain = chainSel.value; changed(); });
  wlBox.addEventListener('change', function () { state.watchlist = wlBox.checked; changed(); });
  sortSel.addEventListener('change', function () { state.sort = sortSel.value; changed(); });
  moreBtn.addEventListener('click', function () { state.shown += PAGE; render(); });

  // ---------- detail drawer ----------
  var backdrop = null, drawer = null;
  function closeDetail() {
    if (backdrop) backdrop.remove();
    if (drawer) drawer.remove();
    backdrop = drawer = null;
    document.removeEventListener('keydown', onKey);
  }
  function onKey(e) { if (e.key === 'Escape') closeDetail(); }

  function openDetail(r) {
    closeDetail();
    backdrop = el('div', 'backdrop');
    backdrop.addEventListener('click', closeDetail);
    document.body.appendChild(backdrop);

    drawer = el('aside', 'drawer');
    var closeBtn = el('button', 'close', 'Close');
    closeBtn.addEventListener('click', closeDetail);
    drawer.appendChild(closeBtn);

    var title = el('h2', null, r.name);
    if (r.watchlist) title.appendChild(el('span', 'wl-badge', 'WL'));
    drawer.appendChild(title);
    drawer.appendChild(el('div', 'd-cat',
      (r.category === null || r.category === undefined ? 'Uncategorized' : r.category) + ' · Rank #' + r.rank + ' of ' + rows.length));
    drawer.appendChild(el('div', 'big-value', moneyFull(r.implied_value_usd)));
    drawer.appendChild(el('div', 'big-label', 'Implied value'));

    drawer.appendChild(el('h3', null, 'Model breakdown'));
    var bt = el('table', 'breakdown');
    var catInfo = (r.category && D.method.categories[r.category]) || null;
    var lines = [
      ['TVL', moneyFull(r.tvl_usd)],
      ['Category multiple (' + (catInfo ? catInfo.peers : r.peers) + ' tokenized peers, global median ' +
        Number(D.method.global_median).toFixed(2) + 'x)', Number(r.multiple).toFixed(2) + 'x'],
      ['Momentum (7d TVL)', factor(r.momentum)],
      ['Maturity (age without a token)', factor(r.maturity)],
      ['Scope (chain footprint)', factor(r.scope)]
    ];
    lines.forEach(function (pair) {
      var tr = document.createElement('tr');
      tr.appendChild(el('td', null, pair[0]));
      tr.appendChild(el('td', null, pair[1]));
      bt.appendChild(tr);
    });
    var tot = document.createElement('tr');
    tot.className = 'total';
    tot.appendChild(el('td', null, '= Implied value'));
    tot.appendChild(el('td', null, moneyFull(r.implied_value_usd)));
    bt.appendChild(tot);
    drawer.appendChild(bt);

    drawer.appendChild(el('h3', null, 'Signals'));
    var sigBox = el('div');
    (r.signals || []).forEach(function (s) { sigBox.appendChild(el('span', 'chip', s)); });
    drawer.appendChild(sigBox);

    drawer.appendChild(el('h3', null, 'Facts'));
    var meta = el('div', 'meta');
    [
      ['Chains (' + (r.chains || []).length + ')', (r.chains || []).length ? r.chains.join(', ') : 'None reported'],
      ['Listed on DefiLlama', r.listed_at || 'Not reported'],
      ['Age without a token', r.age_days === null || r.age_days === undefined ? 'Unknown' : r.age_days + ' days (' + ageText(r.age_days) + ')'],
      ['7d TVL change', pct(r.change_7d) === null ? 'Not reported' : pct(r.change_7d)],
      ['Watchlist', r.watchlist ? 'Yes — one of the ' + D.stats.watchlist + ' tracked protocols' : 'No']
    ].forEach(function (pair) {
      var line = el('div');
      line.appendChild(el('span', null, pair[0] + ': '));
      line.appendChild(document.createTextNode(pair[1]));
      meta.appendChild(line);
    });
    drawer.appendChild(meta);

    drawer.appendChild(el('h3', null, 'Farm plan'));
    var ol = document.createElement('ol');
    ol.className = 'farm';
    (r.farm_steps || []).forEach(function (s) { ol.appendChild(el('li', null, s)); });
    drawer.appendChild(ol);

    document.body.appendChild(drawer);
    document.addEventListener('keydown', onKey);
  }

  render();
})();
