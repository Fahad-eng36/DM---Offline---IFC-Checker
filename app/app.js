/* DM QAQC Checker window. Screens: New check, Results, Requirements, History, Settings. */
(function () {
  'use strict';
  var dm = window.dm;
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var num = function (n) { return Number(n).toLocaleString('en-US'); };
  var fmt2 = function (n) { return Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  var slug = function (s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); };
  var local = {
    get: function (k) { try { return localStorage.getItem('dmapp-' + k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem('dmapp-' + k, v); } catch (e) {} }
  };
  var PAGE = 200;
  var NAMING = /^PN\d+_BI\d+_PA\d+_(AR|ST|ME)_\d+\.ifc$/i;
  var LEVELS = ['Critical', 'Error', 'Warning'];
  var LEVEL_CLASS = { Critical: 'crit', Error: 'err', Warning: 'warn' };
  var CATEGORY = {
    EntityIsMissingRequiredAttribute: 'Required property not in the model',
    EntityIsMissingRequiredPropertySet: 'Required property set not in the model',
    EntityIsMissingAttributeValue: 'Property has no value',
    EntityTypeIncorrect: 'Type not accepted',
    IfcEntityHasNoSchema: 'Entity type has no requirements',
    IfcEntitySubTypeHasNoSchema: 'Subtype has no requirements',
    General: 'General'
  };
  var catName = function (c) { return CATEGORY[c] || String(c || 'Other').replace(/([a-z])([A-Z])/g, '$1 $2'); };

  var state = {
    view: 'new', settings: null, rules: null,
    folder: '', files: [], includeWarnings: true, runCard: true, running: false, progress: null, started: 0, error: '',
    run: null, tab: 'issues', level: '', file: '', cat: '', q: '', mode: 'group', group: null, limit: PAGE,
    measure: 'bua', tol: 1, hideEmpty: true, pick: null, typed: {},
    history: null, confirmDelete: null,
    req: { ver: -1, phase: -1, group: 'door', q: '', allSubs: false }
  };

  // ------------------------------------------------------------------ navigation
  function nav() {
    var items = [['new', 'New check'], ['results', 'Results'], ['requirements', 'Requirements'], ['history', 'History'], ['settings', 'Settings']];
    $('nav').innerHTML = items.map(function (i) {
      var badge = i[0] === 'results' && state.run ? '<span class="badge">' + num(state.run.issues.length) + '</span>' : '';
      return '<button type="button" data-view="' + i[0] + '"' + (state.view === i[0] ? ' aria-current="page"' : '') + '><span>' + i[1] + '</span>' + badge + '</button>';
    }).join('');
  }
  function go(view) {
    state.view = view; state.confirmDelete = null;
    if (view === 'history') dm.historyList().then(function (h) { state.history = h; render(); });
    render();
    $('main').scrollTop = 0;
  }
  function render() {
    nav();
    var h = state.view === 'new' ? viewNew() : state.view === 'results' ? viewResults() : state.view === 'requirements' ? viewRequirements() : state.view === 'history' ? viewHistory() : viewSettings();
    $('main').innerHTML = h;
  }
  function head(title, sub, right) {
    return '<div class="pagehead"><div class="title"><h1>' + title + '</h1><div class="muted">' + sub + '</div></div>' + (right ? '<div class="filters">' + right + '</div>' : '') + '</div>';
  }

  // ------------------------------------------------------------------ new check
  function mb(b) { return (b / 1048576).toFixed(b > 10485760 ? 0 : 1) + ' MB'; }
  function viewNew() {
    var s = state.settings || {}, h = head('New check', 'Run the Dubai Municipality QA/QC checker on a folder of IFC exports.');
    if (!s.qaqcPath) h += '<p class="notice bad">The DM QA/QC checker built into this app is missing. Reinstall the app, or choose a copy in <button type="button" class="linkbtn" data-view="settings">Settings</button>.</p>';
    if (state.running) {
      var p = state.progress || { text: 'Starting…', done: 0, total: 0 }, secs = Math.round((Date.now() - state.started) / 1000);
      h += '<section class="card pad"><h2>Checking ' + esc(baseName(state.folder)) + '</h2><div>' + esc(p.text) + '</div>' +
        (p.total ? '<progress max="' + p.total + '" value="' + p.done + '"></progress><div class="muted">' + 'Step ' + p.done + ' of ' + p.total + ' (each file is opened, then checked) · ' + clock(secs) + ' elapsed</div>' : '<progress></progress><div class="muted">' + clock(secs) + ' elapsed</div>') +
        '<p class="muted" style="margin:0">Large models take several minutes. You can keep using Requirements and History meanwhile.</p>' +
        '<div><button type="button" class="btn" id="stop">Stop the check</button></div></section>';
      return h;
    }
    if (state.error) h += '<p class="notice bad">' + esc(state.error).replace(/\n/g, '<br>') + '</p>';
    h += '<section class="card pad"><h2>1. Choose the IFC folder</h2><div class="drop" id="drop"><p>' + (state.folder ? '<b>' + esc(state.folder) + '</b>' : 'Drop the folder that holds the <b>.ifc</b> files here, or choose it.') + '</p><button type="button" class="btn" id="pick">' + (state.folder ? 'Choose another folder' : 'Choose folder') + '</button></div>' +
      '<div class="field grow"><label for="path">Or paste the folder path</label><div class="row"><input id="path" type="text" style="flex:1 1 320px" placeholder="D:\\Projects\\Tower\\IFC"><button type="button" class="btn" id="use-path">Use this folder</button></div></div>';
    if (state.folder) {
      if (!state.files.length) h += '<p class="notice">There are no .ifc files in this folder.</p>';
      else {
        var bad = state.files.filter(function (f) { return !NAMING.test(f.name); });
        if (bad.length) h += '<p class="notice">' + bad.length + (bad.length === 1 ? ' file does' : ' files do') + ' not follow the DM file name convention (for example <span class="mono">PN476511_BI000001_PA6184096_AR_001.ifc</span>). The DM tools stop when they meet such a name.</p>';
        h += '<div class="scroll"><table><thead><tr><th>File</th><th>Discipline</th><th class="num">Size</th><th>Name</th></tr></thead><tbody>' + state.files.map(function (f) {
          var m = /_(AR|ST|ME)_(\d+)\.ifc$/i.exec(f.name);
          return '<tr><td class="wrap mono">' + esc(f.name) + '</td><td>' + (m ? { AR: 'Architecture', ST: 'Structure', ME: 'MEP' }[m[1].toUpperCase()] : '–') + '</td><td class="num">' + mb(f.size) + '</td><td>' + (NAMING.test(f.name) ? '<span class="pill ok">Follows convention</span>' : '<span class="pill warn">Check the name</span>') + '</td></tr>';
        }).join('') + '</tbody></table></div>';
      }
    }
    h += '</section><section class="card pad"><h2>2. Options</h2>' +
      '<label class="check"><input type="checkbox" id="opt-warn"' + (state.includeWarnings ? ' checked' : '') + '><span>Include warnings<small>Off reports only Critical and Error issues, as the DM tool offers.</small></span></label>' +
      '<label class="check"><input type="checkbox" id="opt-card"' + (state.runCard ? ' checked' : '') + (s.cardPath ? '' : ' disabled') + '><span>Also compute storey areas<small>' + (s.cardPath ? 'Runs the DM building card generator to compare computed BUA, GFA, GA and net area with the declared figures.' : 'The DM building card generator built into this app is missing; reinstall the app or choose a copy in Settings.') + '</small></span></label>' +
      '<label class="check"><input type="checkbox" id="opt-grid"' + (state.writeGrid ? ' checked' : '') + '><span>Also let the DM tool write ModelInfoGrid.xlsx<small>Off by default. The DM tool builds this file after its results and it can add many minutes and several GB of memory on large models. This app does not use it.</small></span></label>' +
      '<div class="row"><button type="button" class="btn primary" id="run"' + (state.files.length && s.qaqcPath ? '' : ' disabled') + '>Run check</button>' +
      (state.hasResults ? '<button type="button" class="btn" id="import">Open the results already in this folder</button>' : '') + '</div>' +
      (state.hasResults ? '<div class="muted">This folder already holds a <span class="mono">QaQcResults.csv</span> from the DM checker. Opening it is instant; running the check again can take many minutes.</div>' : '') + '</section>';
    return h;
  }
  function baseName(p) { return String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop(); }
  function clock(s) { return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2); }
  function setFolder(folder) {
    if (!folder) return;
    dm.inspectFolder(folder).then(function (r) {
      if (!r.ok) { state.error = 'That is not a folder. Drop or choose the folder that holds the IFC files.'; render(); return; }
      state.folder = folder; state.files = r.files; state.hasResults = !!r.hasResults; state.error = ''; local.set('folder', folder); render();
    });
  }
  function startCheck() {
    state.running = true; state.error = ''; state.progress = null; state.started = Date.now(); render();
    var tick = setInterval(function () { if (state.running && state.view === 'new') render(); }, 1000);
    dm.runCheck({ folder: state.folder, includeWarnings: state.includeWarnings, runCard: state.runCard && !!state.settings.cardPath, writeGrid: !!state.writeGrid }).then(function (r) {
      clearInterval(tick); state.running = false;
      if (r.error) { state.error = r.error; state.view = 'new'; render(); return; }
      openRun(r.run);
    });
  }
  function openRun(run) {
    state.run = run; state.tab = 'issues'; state.level = ''; state.file = ''; state.cat = ''; state.q = ''; state.mode = 'group'; state.group = null; state.limit = PAGE; state.pick = null;
    try { state.typed = JSON.parse(local.get('typed-' + run.folder) || '{}'); } catch (e) { state.typed = {}; }
    go('results');
  }

  // ------------------------------------------------------------------ results
  function shortFile(f) { var m = /_((?:AR|ST|ME)_\d+)\.ifc$/i.exec(f); return m ? m[1] : (f.indexOf(',') !== -1 ? 'All files' : f); }
  function generic(msg) { return msg.replace(/^Entity \[[^\]]+\]:\s*/, '').replace(/\[[0-9A-Za-z_$]{22}\]/g, '[another element]'); }
  function filtered() {
    var r = state.run, q = state.q.toLowerCase();
    return r.issues.filter(function (i) {
      if (state.level && i.level !== state.level) return false;
      if (state.file && i.file !== state.file) return false;
      if (state.cat && i.category !== state.cat) return false;
      if (state.group && (i.level + '|' + i.category + '|' + generic(i.msg)) !== state.group) return false;
      if (q && (i.msg + ' ' + i.type + ' ' + (i.name || '') + ' ' + (i.tag || '')).toLowerCase().indexOf(q) === -1) return false;
      return true;
    });
  }
  function viewResults() {
    var r = state.run;
    if (!r) return head('Results', 'The findings of a check appear here.') + '<section class="card"><p class="empty">No check is open. <button type="button" class="linkbtn" data-view="new">Run a new check</button> or open one from <button type="button" class="linkbtn" data-view="history">History</button>.</p></section>';
    var h = head('Results', esc(r.folder) + ' · ' + new Date(r.when).toLocaleString() + ' · ' + r.files.length + ' files' + (r.seconds ? ' · took ' + clock(r.seconds) : '') + (r.includeWarnings ? '' : ' · warnings not included'),
      '<div class="seg" role="group" aria-label="Section"><button type="button" data-tab="issues" aria-pressed="' + (state.tab === 'issues') + '">Issues</button><button type="button" data-tab="areas" aria-pressed="' + (state.tab === 'areas') + '">Storey areas</button></div>');
    (r.notes || []).forEach(function (n) { h += '<p class="notice">' + esc(n) + '</p>'; });
    return h + (state.tab === 'issues' ? viewIssues() : viewAreas());
  }
  function viewIssues() {
    var r = state.run, all = r.issues, counts = {};
    all.forEach(function (i) { counts[i.level] = (counts[i.level] || 0) + 1; });
    var h = '<div class="tiles"><button type="button" class="tile" data-level="" aria-pressed="' + (state.level === '') + '"><b>' + num(all.length) + '</b><span>All issues</span></button>' +
      LEVELS.map(function (l) { return '<button type="button" class="tile ' + LEVEL_CLASS[l] + '" data-level="' + l + '" aria-pressed="' + (state.level === l) + '"><b>' + num(counts[l] || 0) + '</b><span>' + l + '</span></button>'; }).join('') + '</div>';
    if (!all.length) return h + '<section class="card"><p class="empty">The DM checker reported no issues for these files.</p></section>';
    var files = uniq(all.map(function (i) { return i.file; })), cats = uniq(all.map(function (i) { return i.category; }));
    h += '<div class="filters"><div class="field"><label for="f-file">File</label><select id="f-file"><option value="">All files</option>' + files.map(function (f) { return '<option value="' + esc(f) + '"' + (state.file === f ? ' selected' : '') + '>' + esc(shortFile(f)) + '</option>'; }).join('') + '</select></div>' +
      '<div class="field"><label for="f-cat">Kind of issue</label><select id="f-cat"><option value="">All kinds</option>' + cats.map(function (c) { return '<option value="' + esc(c) + '"' + (state.cat === c ? ' selected' : '') + '>' + esc(catName(c)) + '</option>'; }).join('') + '</select></div>' +
      '<div class="field"><label for="f-q">Search</label><input id="f-q" type="search" placeholder="e.g. FireRating, IfcDoor" value="' + esc(state.q) + '"></div>' +
      '<div class="seg" role="group" aria-label="View"><button type="button" data-mode="group" aria-pressed="' + (state.mode === 'group') + '">By issue</button><button type="button" data-mode="rows" aria-pressed="' + (state.mode === 'rows') + '">Every row</button></div></div>';
    var list = filtered();
    h += '<section class="card">';
    if (state.group) h += '<div class="cardhead"><div class="row"><span class="pill req">Showing one issue</span><span>' + esc(state.group.split('|').slice(2).join('|')) + '</span><button type="button" class="btn small" id="clear-group">Show all issues</button></div></div>';
    if (!list.length) h += '<p class="empty">No issue matches these filters.</p>';
    else if (state.mode === 'group' && !state.group) {
      var groups = {}, order = [];
      list.forEach(function (i) {
        var k = i.level + '|' + i.category + '|' + generic(i.msg), g = groups[k];
        if (!g) { g = groups[k] = { key: k, level: i.level, cat: i.category, msg: generic(i.msg), n: 0, files: {}, types: {} }; order.push(g); }
        g.n++; g.files[i.file] = 1; if (i.type) g.types[i.type] = 1;
      });
      order.sort(function (a, b) { return LEVELS.indexOf(a.level) - LEVELS.indexOf(b.level) || b.n - a.n; });
      h += '<div class="scroll"><table><thead><tr><th>Level</th><th>Issue</th><th>Entity</th><th class="num">Files</th><th class="num">Rows</th></tr></thead><tbody>' +
        order.slice(0, state.limit).map(function (g) {
          return '<tr class="pick" data-group="' + esc(g.key) + '"><td>' + levelPill(g.level) + '</td><td class="msg">' + esc(g.msg) + '<div class="muted">' + esc(catName(g.cat)) + '</div></td><td class="mono">' + esc(Object.keys(g.types).join(', ')) + '</td><td class="num">' + Object.keys(g.files).length + '</td><td class="num">' + num(g.n) + '</td></tr>';
        }).join('') + '</tbody></table></div>' + foot(order.length, 'distinct issues', list);
    } else {
      h += '<div class="scroll"><table><thead><tr><th>Level</th><th>File</th><th>Entity</th><th>Element</th><th>Revit ID</th><th>Message</th></tr></thead><tbody>' +
        list.slice(0, state.limit).map(function (i) {
          return '<tr><td>' + levelPill(i.level) + '</td><td class="mono">' + esc(shortFile(i.file)) + '</td><td class="mono">' + esc(i.type) + '</td><td class="wrap">' + (i.name ? esc(i.name) : '<span class="muted">' + (i.guid ? esc(i.guid) : 'Whole model') + '</span>') + '</td><td class="mono">' + (i.tag ? esc(i.tag) : '<span class="muted">–</span>') + '</td><td class="msg">' + esc(i.msg) + '</td></tr>';
        }).join('') + '</tbody></table></div>' + foot(list.length, 'rows', list);
    }
    return h + '</section>';
  }
  function foot(total, word, list) {
    var tags = list.filter(function (i) { return i.tag; }).length;
    return '<div class="cardfoot"><span>Showing ' + num(Math.min(state.limit, total)) + ' of ' + num(total) + ' ' + word + (total > state.limit ? ' <button type="button" class="btn small" id="more">Show more</button>' : '') + '</span><span class="row">' +
      (tags ? '<button type="button" class="btn small" id="copy-ids" title="Paste into Revit: Manage, Select by ID">Copy ' + num(tags) + ' Revit IDs</button>' : '') +
      '<button type="button" class="btn small" id="export">Save these rows as CSV</button><button type="button" class="btn small" id="show-file">Show the DM results file</button></span></div>';
  }
  function levelPill(l) { return '<span class="pill ' + (LEVEL_CLASS[l] || '') + '">' + esc(l) + '</span>'; }
  function uniq(a) { var s = {}, o = []; a.forEach(function (x) { if (!s[x]) { s[x] = 1; o.push(x); } }); return o.sort(); }
  function csvOf(list) {
    var q = function (v) { v = String(v == null ? '' : v); return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    return [['Level', 'File', 'Kind', 'Entity', 'Element', 'Revit ID', 'GlobalId', 'Message']].concat(list.map(function (i) { return [i.level, i.file, catName(i.category), i.type, i.name || '', i.tag || '', i.guid || '', i.msg]; }))
      .map(function (r) { return r.map(q).join(','); }).join('\r\n');
  }

  // ------------------------------------------------------------------ storey areas
  var M = {
    bua: { name: 'Built-up area (BUA)', short: 'BUA', a: 'buaA', m: 'buaM', walls: 'wBua', spaces: 'sBua', cols: true, flag: 1 },
    gfa: { name: 'Gross floor area (GFA)', short: 'GFA', a: 'gfaA', m: 'gfaM', walls: 'wGfa', spaces: 'sGfa', cols: true, flag: 8 },
    ga: { name: 'Gross area (GA)', short: 'GA', a: 'gaA', m: 'gaM', walls: 'wGa', spaces: 'sGa', cols: true, flag: 2 },
    net: { name: 'Net area', short: 'Net', a: 'naA', m: 'naM', walls: null, spaces: null, cols: false, flag: 4 }
  };
  function declared(s, mk) {
    var t = state.typed[s.key + '|' + mk];
    if (t !== undefined && t !== '') return +t;
    var v = s[M[mk].m];
    return v !== null && v >= 0 ? v : null;
  }
  function areaRows() {
    var m = M[state.measure];
    return state.run.card.storeys.filter(function (s) { return !state.hideEmpty || s[m.a] > 0 || declared(s, state.measure) !== null; });
  }
  function viewAreas() {
    var c = state.run.card;
    if (!c) return '<section class="card"><p class="empty">Storey areas were not computed for this check. Run a new check with “Also compute storey areas” ticked.</p></section>';
    var mk = state.measure, m = M[mk], tol = state.tol, list = areaRows(), tA = 0, tD = 0, nD = 0, nOver = 0;
    var body = list.map(function (s) {
      var a = s[m.a], d = declared(s, mk), p = d ? (a - d) / d * 100 : null, over = p !== null && Math.abs(p) > tol;
      tA += a; if (d !== null) { tD += d; nD++; } if (over) nOver++;
      var dash = '<span class="muted">–</span>';
      return '<tr class="pick" data-storey="' + esc(s.key) + '"' + (state.pick === s.key ? ' aria-current="true"' : '') + '><td class="num">' + esc(s.no) + '</td>' + (c.multiPart ? '<td class="num">' + esc(s.part) + '</td>' : '') +
        '<td>' + esc(s.name) + (s.invalid ? ' <span class="pill warn">invalid space data</span>' : '') + (s.issues ? ' <span class="pill warn">' + esc(s.issues) + '</span>' : '') + '</td>' +
        '<td class="num">' + (m.spaces ? fmt2(s[m.spaces]) : dash) + '</td><td class="num">' + (m.walls ? fmt2(s[m.walls]) : dash) + '</td><td class="num">' + (m.cols ? fmt2(s.cols) : dash) + '</td>' +
        '<td class="num"><b>' + fmt2(a) + '</b></td><td class="num"><input type="number" step="0.01" min="0" data-declared="' + esc(s.key) + '" value="' + (d !== null ? d : '') + '" placeholder="not set" aria-label="Declared ' + m.short + ' for ' + esc(s.name) + '"></td>' +
        '<td class="num">' + (d !== null ? fmt2(a - d) : dash) + '</td><td class="num">' + (p === null ? dash : '<span class="pill ' + (over ? 'crit' : 'ok') + '">' + (p > 0 ? '+' : '') + p.toFixed(2) + '%</span>') + '</td></tr>';
    }).join('');
    var verdict = !nD ? 'No storey has a declared ' + m.short + ' figure in the IFC. The building card computes <b>' + fmt2(tA) + ' m²</b> in total. Type your drawing figures in the Declared column to compare.'
      : nOver ? '<b class="over">' + nOver + '</b> of ' + nD + ' storeys with a declared figure differ from the computed ' + m.short + ' by more than ' + tol + '%.'
      : 'All ' + nD + ' storeys with a declared figure are within ' + tol + '% of the computed ' + m.short + '.';
    var h = '<div class="filters"><div class="field"><label for="a-measure">Area</label><select id="a-measure">' + Object.keys(M).map(function (k) { return '<option value="' + k + '"' + (k === mk ? ' selected' : '') + '>' + M[k].name + '</option>'; }).join('') + '</select></div>' +
      '<div class="field"><label for="a-tol">Flag differences above (%)</label><input id="a-tol" type="number" min="0" step="0.1" value="' + tol + '"></div>' +
      '<label class="check"><input type="checkbox" id="a-hide"' + (state.hideEmpty ? ' checked' : '') + '><span>Hide storeys with no area</span></label></div>' +
      '<section class="card"><div class="cardhead"><div>' + verdict + '</div><div class="muted">' + (m.spaces ? 'Computed ' + m.short + ' = spaces counted in ' + m.short + ' + wall footprints + column footprints.' : 'Computed net area = the net area of spaces counted as net.') + ' Select a storey to see its spaces.</div></div>' +
      '<div class="scroll"><table><thead><tr><th class="num">No</th>' + (c.multiPart ? '<th class="num">Part</th>' : '') + '<th>Storey</th><th class="num">Spaces m²</th><th class="num">Walls m²</th><th class="num">Columns m²</th><th class="num">Computed ' + m.short + '</th><th class="num">Declared ' + m.short + '</th><th class="num">Difference m²</th><th class="num">Difference %</th></tr></thead><tbody>' + body +
      '</tbody><tfoot><tr><td></td>' + (c.multiPart ? '<td></td>' : '') + '<td>Total of ' + list.length + ' rows</td><td></td><td></td><td></td><td class="num">' + fmt2(tA) + '</td><td class="num">' + (nD ? fmt2(tD) : '–') + '</td><td class="num">' + (nD === list.length && tD ? fmt2(tA - tD) : '–') + '</td><td class="num">' + (nD === list.length && tD ? ((tA - tD) / tD * 100).toFixed(2) + '%' : '–') + '</td></tr></tfoot></table></div>' +
      '<div class="cardfoot"><span>' + c.storeys.length + ' storey rows' + (c.multiPart ? ', one per building part' : '') + ' · ' + num(c.spaceCount) + ' spaces · typed figures are kept on this computer</span><span class="row"><button type="button" class="btn small" id="clear-typed">Clear typed figures</button><button type="button" class="btn small" id="export-areas">Save table as CSV</button></span></div></section>';
    return h + viewSpaces();
  }
  function viewSpaces() {
    if (!state.pick) return '';
    var c = state.run.card, s = c.storeys.filter(function (x) { return x.key === state.pick; })[0], m = M[state.measure];
    if (!s) return '';
    var sp = (c.spaces[s.skey] || []).slice().sort(function (a, b) { return b[4] - a[4]; }), inN = 0, inA = 0;
    sp.forEach(function (x) { if (x[5] & m.flag) { inN++; inA += state.measure === 'net' ? x[3] : x[4]; } });
    var h = '<section class="card" id="spaces"><div class="cardhead"><h2>' + esc(s.name) + '</h2><div class="muted">' + sp.length + ' spaces on this storey; ' + inN + ' are counted in ' + m.short + ', adding up to ' + fmt2(inA) + ' m².' + (c.multiPart ? ' The generator does not say which building part a space belongs to, so every part of this storey is listed.' : '') + '</div></div>';
    if (!sp.length) return h + '<p class="empty">The building card found no spaces on this storey. Its figure comes from wall and column footprints only.</p></section>';
    var f = function (x, bit) { return x[5] & bit ? '<span class="pill ok">Yes</span>' : '<span class="muted">–</span>'; };
    return h + '<div class="scroll"><table><thead><tr><th>Space</th><th>Zone type</th><th>Unit</th><th class="num">Net m²</th><th class="num">Gross m²</th><th>BUA</th><th>GFA</th><th>GA</th><th>Net</th><th>Covered</th><th>Issues</th></tr></thead><tbody>' +
      sp.slice(0, state.limit).map(function (x) { return '<tr><td>' + esc(x[0]) + '</td><td class="muted">' + esc(x[1]) + '</td><td>' + esc(x[2]) + '</td><td class="num">' + fmt2(x[3]) + '</td><td class="num">' + fmt2(x[4]) + '</td><td>' + f(x, 1) + '</td><td>' + f(x, 8) + '</td><td>' + f(x, 2) + '</td><td>' + f(x, 4) + '</td><td>' + (x[5] & 16 ? 'Yes' : '<span class="muted">No</span>') + '</td><td>' + esc(x[6]) + '</td></tr>'; }).join('') +
      '</tbody></table></div><div class="cardfoot"><span>Showing ' + Math.min(state.limit, sp.length) + ' of ' + sp.length + ' spaces' + (sp.length > state.limit ? ' <button type="button" class="btn small" id="more">Show more</button>' : '') + '</span></div></section>';
  }
  function areasCsv() {
    var m = M[state.measure], c = state.run.card;
    return [['No', 'Part', 'Storey', 'Spaces m2', 'Walls m2', 'Columns m2', 'Computed ' + m.short, 'Declared ' + m.short, 'Difference m2', 'Difference %']].concat(areaRows().map(function (s) {
      var a = s[m.a], d = declared(s, state.measure);
      return [s.no, s.part, '"' + s.name.replace(/"/g, '""') + '"', m.spaces ? s[m.spaces] : '', m.walls ? s[m.walls] : '', m.cols ? s.cols : '', a, d !== null ? d : '', d !== null ? (a - d).toFixed(4) : '', d ? ((a - d) / d * 100).toFixed(2) : ''];
    })).map(function (r) { return r.join(','); }).join('\r\n');
  }

  // ------------------------------------------------------------------ requirements
  var STRUCT = ['IfcFooting', 'IfcPile', 'IfcSlab', 'IfcWall', 'IfcColumn', 'IfcBeam', 'IfcMember', 'IfcPlate', 'IfcStair', 'IfcRamp', 'IfcRoof'];
  var GENERAL = ['IfcProject', 'IfcSite', 'IfcBuilding', 'IfcBuildingStorey'];
  var SECTIONS = ['general', 'struct', 'arch'], DISC_NAME = { general: 'General', arch: 'Architecture', struct: 'Structure' }, SUBS_SHOWN = 12;
  function rGroups() { return state.rules.versions[state.req.ver].groups; }
  function disc(g) { return STRUCT.indexOf(g.type) !== -1 ? 'struct' : GENERAL.indexOf(g.type) !== -1 ? 'general' : 'arch'; }
  function rSection(k) { var gs = rGroups().filter(function (g) { return disc(g) === k; }); if (k === 'struct') gs.sort(function (a, b) { return STRUCT.indexOf(a.type) - STRUCT.indexOf(b.type); }); return gs; }
  function rCurrent() { var gs = rGroups(); for (var i = 0; i < gs.length; i++) if (slug(gs[i].name) === state.req.group) return gs[i]; return gs[0]; }
  function isReq(a, ph) { return a[6].charAt(ph) === '1'; }
  function rShown(g) { return state.req.phase < 0 ? g.attrs : g.attrs.filter(function (a) { return isReq(a, state.req.phase); }); }
  function propCell(a) {
    var d = (a[7] || '').trim(), std = /^IFC Standard Property/i.test(d), note = !d || d === 'NA' || /^IFC Standard Property\.?$/i.test(d) ? '' : d.replace(/^IFC Standard Property\.?\s*/i, '');
    var h = '<div class="pset">' + esc(a[0]) + '</div><div class="pname">' + esc(a[1]) + (std ? '<span class="tag">IFC standard</span>' : '') + (!a[5] ? '<span class="tag">no user input</span>' : '') + '</div>';
    var ref = (a[2] || '').trim();
    if (ref && ref !== a[1]) h += '<div class="pnote">Name in IFC: <b>' + esc(ref) + '</b></div>';
    if (note) h += '<div class="pnote">' + esc(note) + '</div>';
    return h;
  }
  function viewRequirements() {
    var R = state.rules, r = state.req;
    if (!R) return head('Requirements', 'What each element needs, by phase.') + '<section class="card"><p class="empty">The rule file could not be read. Check the DM QA/QC checker in <button type="button" class="linkbtn" data-view="settings">Settings</button>.</p></section>';
    if (r.ver < 0 || !R.versions[r.ver]) r.ver = R.versions.length - 1;
    var P = R.phases, phHeads = P.map(function (p) { return '<th>' + esc(p) + '</th>'; }).join('');
    var phCells = function (a) { return P.map(function (p, i) { return '<td>' + (isReq(a, i) ? '<span class="pill req">Required</span>' : '<span class="muted">Optional</span>') + '</td>'; }).join(''); };
    var h = head('Requirements', 'What each element needs, by phase. Read directly from the checker’s rule file.',
      '<div class="field"><label for="req-ifc">IFC version</label><select id="req-ifc">' + R.versions.map(function (v, i) { return '<option value="' + i + '"' + (i === r.ver ? ' selected' : '') + '>' + esc(v.name) + '</option>'; }).join('') + '</select></div>' +
      '<div class="field"><label for="req-phase">Phase</label><select id="req-phase"><option value="-1">All phases</option>' + P.map(function (p, i) { return '<option value="' + i + '"' + (i === r.phase ? ' selected' : '') + '>' + esc(p) + '</option>'; }).join('') + '</select></div>' +
      '<div class="field"><label for="req-search">Search properties</label><input id="req-search" type="search" placeholder="e.g. FireRating" value="' + esc(r.q) + '"></div>');
    var cur = slug(rCurrent().name);
    h += '<div class="cols"><section class="card groups" aria-label="Element groups"><h3>' + rGroups().length + ' element groups</h3><div class="list">' + SECTIONS.map(function (k) {
      return '<div class="sec" data-disc="' + k + '"><span class="dot"></span>' + DISC_NAME[k] + '</div>' + rSection(k).map(function (g) {
        var s = slug(g.name);
        return '<button type="button" data-rgroup="' + s + '" aria-pressed="' + (s === cur && !r.q) + '"><span>' + esc(g.name) + '</span><span class="n">' + rShown(g).length + '</span></button>';
      }).join('');
    }).join('') + '</div></section><section class="card detail">';
    if (r.q) {
      var q = r.q.toLowerCase(), hits = [];
      rGroups().forEach(function (g) { rShown(g).forEach(function (a) { if ((a[1] + ' ' + a[2] + ' ' + a[0] + ' ' + (a[7] || '')).toLowerCase().indexOf(q) !== -1) hits.push([g, a]); }); });
      h += '<div class="cardhead"><div class="row"><h2>Properties matching “' + esc(r.q) + '”</h2><span class="muted">· ' + hits.length + (hits.length === 1 ? ' match' : ' matches') + ' across ' + rGroups().length + ' element groups</span></div></div>' +
        (hits.length ? '<div class="scroll"><table><thead><tr><th>Element</th><th>Property</th><th>Type</th>' + phHeads + '</tr></thead><tbody>' + hits.map(function (x) { return '<tr><td><button type="button" class="linkbtn" data-rgroup="' + slug(x[0].name) + '">' + esc(x[0].name) + '</button></td><td>' + propCell(x[1]) + '</td><td class="mono">' + esc(x[1][3]) + '</td>' + phCells(x[1]) + '</tr>'; }).join('') + '</tbody></table></div>' : '<p class="empty">No property, property set or description contains that text.</p>');
    } else {
      var g = rCurrent(), list = rShown(g), dk = disc(g), subs = g.subs.filter(function (s) { return s[0] !== 'NOTFOUND'; }).map(function (s) { return s[1] ? (s[0] === 'USERDEFINED' ? s[1] : s[0] + ' · ' + s[1]) : s[0]; });
      var cut = r.allSubs ? subs : subs.slice(0, SUBS_SHOWN);
      h += '<div class="cardhead"><div class="row"><h2>' + esc(g.name) + '</h2><span class="mono muted">' + esc(g.type) + '</span><span class="muted">· ' + g.attrs.length + ' properties · ' + subs.length + ' subtypes</span>' + (dk !== 'general' ? '<span class="disc" data-disc="' + dk + '"><span class="dot"></span>' + DISC_NAME[dk] + '</span>' : '') + '</div>' +
        (g.desc ? '<div class="muted">' + esc(g.desc) + '</div>' : '') + '<div class="muted">Accepted subtypes</div><div class="pills">' +
        (subs.length ? cut.map(function (s) { return '<span class="pill">' + esc(s) + '</span>'; }).join('') + (subs.length > SUBS_SHOWN ? '<button type="button" class="pill more" id="more-subs">' + (r.allSubs ? 'Show fewer' : '+' + (subs.length - SUBS_SHOWN) + ' more') + '</button>' : '') : '<span class="muted">None listed. The checker accepts this element without a predefined type.</span>') + '</div></div>';
      h += !g.attrs.length ? '<p class="empty">The rule file lists no properties for this element. Only its type is checked.</p>'
        : !list.length ? '<p class="empty">Nothing is required of this element at ' + esc(P[r.phase]) + '. Choose All phases to see every property.</p>'
        : '<div class="scroll"><table><thead><tr><th>Property</th><th>Type</th><th>Sample</th>' + phHeads + '</tr></thead><tbody>' + list.map(function (a) { return '<tr><td>' + propCell(a) + '</td><td class="mono">' + esc(a[3]) + '</td><td>' + (a[4] ? esc(a[4]) : '<span class="muted">–</span>') + '</td>' + phCells(a) + '</tr>'; }).join('') + '</tbody></table></div>';
      h += '<div class="cardfoot"><span>Showing ' + list.length + ' of ' + g.attrs.length + ' properties' + (r.phase >= 0 ? ' · required at ' + esc(P[r.phase]) : '') + '</span></div>';
    }
    return h + '</section></div>';
  }

  // ------------------------------------------------------------------ history
  function viewHistory() {
    var h = head('History', 'Checks run on this computer. Open one to see its results again.');
    if (!state.history) return h + '<section class="card"><p class="empty">Loading…</p></section>';
    if (!state.history.length) return h + '<section class="card"><p class="empty">No checks yet. <button type="button" class="linkbtn" data-view="new">Run a new check</button>.</p></section>';
    return h + '<section class="card"><div class="scroll"><table><thead><tr><th>When</th><th>Folder</th><th class="num">Files</th><th>Issues</th><th>Areas</th><th class="num">Took</th><th></th></tr></thead><tbody>' + state.history.map(function (r) {
      var pills = LEVELS.filter(function (l) { return r.counts[l]; }).map(function (l) { return '<span class="pill ' + LEVEL_CLASS[l] + '">' + num(r.counts[l]) + ' ' + l.toLowerCase() + '</span>'; }).join(' ') || '<span class="pill ok">No issues</span>';
      var act = state.confirmDelete === r.id ? '<span class="row"><span>Delete this check?</span><button type="button" class="btn small danger" data-delete-yes="' + esc(r.id) + '">Delete</button><button type="button" class="btn small" data-delete-no="1">Keep</button></span>'
        : '<span class="row"><button type="button" class="btn small" data-open="' + esc(r.id) + '">Open</button><button type="button" class="btn small" data-delete="' + esc(r.id) + '">Delete</button></span>';
      return '<tr><td>' + new Date(r.when).toLocaleString() + '</td><td class="wrap">' + esc(r.folder) + '</td><td class="num">' + r.files + '</td><td><div class="pills">' + pills + '</div>' + (r.includeWarnings ? '' : '<div class="muted">warnings not included</div>') + '</td><td>' + (r.hasCard ? 'Yes' : '<span class="muted">–</span>') + '</td><td class="num">' + (r.seconds ? clock(r.seconds) : '–') + '</td><td>' + act + '</td></tr>';
    }).join('') + '</tbody></table></div></section>';
  }

  // ------------------------------------------------------------------ settings
  function viewSettings() {
    var s = state.settings || {};
    var tool = function (key, label, exe, help) {
      var pill = s[key + 'BuiltIn'] ? '<span class="pill ok">Built in</span> ' : s[key] ? '<span class="pill ok">Your copy</span> ' : '<span class="pill warn">Missing</span> ';
      var reset = s[key] && !s[key + 'BuiltIn'] ? '<button type="button" class="btn" data-builtin="' + key + '">Use built-in copy</button>' : '';
      return '<div class="field grow"><label for="set-' + key + '">' + label + '</label><div class="row"><input id="set-' + key + '" type="text" style="flex:1 1 320px" value="' + esc(s[key] || '') + '" placeholder="Not found" readonly><button type="button" class="btn" data-browse="' + key + '" data-title="Choose ' + exe + '">Use another copy</button>' + reset + '</div><div class="muted">' + pill + help + '</div></div>';
    };
    return head('Settings', 'The Dubai Municipality tools this app runs.') +
      '<section class="card pad"><h2>DM tools</h2>' +
      '<p class="muted">Both tools come built into this app; nothing else needs to be installed. Choose another copy only to use a newer release from Dubai Municipality.</p>' +
      tool('qaqcPath', 'DM QA/QC checker', 'BIMToolkit.QAQCChecker.App.exe', 'Runs the check and supplies the rules shown under Requirements.') +
      tool('cardPath', 'DM building card generator', 'BIMToolkit.BuildingCardGenerator.App.exe', 'Computes storey areas.') +
      '<p class="muted" style="margin:0">Both tools are published by Dubai Municipality. This app runs them as they are and only presents what they report.</p></section>';
  }

  // ------------------------------------------------------------------ events
  document.addEventListener('click', function (e) {
    var t = e.target.closest ? e.target.closest('button, tr.pick') : null;
    if (!t || (e.target.tagName === 'INPUT')) return;
    var d = t.dataset;
    if (d.view) return go(d.view);
    if (t.id === 'pick') return dm.pickFolder().then(setFolder);
    if (t.id === 'use-path') { var typedPath = $('path').value.trim().replace(/^"|"$/g, ''); if (typedPath) setFolder(typedPath); return; }
    if (t.id === 'run') return startCheck();
    if (t.id === 'import') { t.disabled = true; t.textContent = 'Opening…'; return dm.importResults(state.folder).then(function (r) { if (r.error) { state.error = r.error; return render(); } openRun(r.run); }); }
    if (t.id === 'stop') return dm.stopCheck();
    if (d.tab) { state.tab = d.tab; state.limit = PAGE; return render(); }
    if (d.level !== undefined && t.classList.contains('tile')) { state.level = d.level; state.limit = PAGE; return render(); }
    if (d.mode) { state.mode = d.mode; state.group = null; state.limit = PAGE; return render(); }
    if (d.group) { state.group = d.group; state.limit = PAGE; return render(); }
    if (t.id === 'clear-group') { state.group = null; state.limit = PAGE; return render(); }
    if (t.id === 'more') { state.limit += PAGE; return render(); }
    if (t.id === 'export') return dm.saveCsv('DM-QAQC-issues.csv', csvOf(filtered())).then(function (p) { if (p) flash(t, 'Saved'); });
    if (t.id === 'export-areas') return dm.saveCsv('DM-storey-areas-' + M[state.measure].short + '.csv', areasCsv()).then(function (p) { if (p) flash(t, 'Saved'); });
    if (t.id === 'show-file') return dm.showInFolder(state.run.resultsFile);
    if (t.id === 'copy-ids') { var ids = uniq(filtered().map(function (i) { return i.tag; }).filter(Boolean)).join(';'); return navigator.clipboard.writeText(ids).then(function () { flash(t, 'Copied'); }, function () { flash(t, 'Copy was blocked'); }); }
    if (d.storey) { state.pick = state.pick === d.storey ? null : d.storey; state.limit = PAGE; render(); var el = $('spaces'); if (el) el.scrollIntoView({ block: 'nearest' }); return; }
    if (t.id === 'clear-typed') { state.typed = {}; local.set('typed-' + state.run.folder, '{}'); return render(); }
    if (d.rgroup) { state.req.group = d.rgroup; state.req.q = ''; state.req.allSubs = false; return render(); }
    if (t.id === 'more-subs') { state.req.allSubs = !state.req.allSubs; return render(); }
    if (d.open) return dm.historyGet(d.open).then(function (r) { if (r) openRun(r); });
    if (d['delete']) { state.confirmDelete = d['delete']; return render(); }
    if (d.deleteNo) { state.confirmDelete = null; return render(); }
    if (d.deleteYes) return dm.historyDelete(d.deleteYes).then(function () { if (state.run && state.run.id === d.deleteYes) state.run = null; go('history'); });
    if (d.browse || d.builtin) {
      var key = d.browse || d.builtin;
      return (d.browse ? dm.pickExe(d.title) : Promise.resolve('')).then(function (p) {
        if (d.browse && !p) return;
        var patch = {}; patch[key] = p;
        return dm.setSettings(patch).then(function (s) { state.settings = s; return loadRules(); }).then(render);
      });
    }
  });
  function flash(btn, msg) { var old = btn.textContent; btn.textContent = msg; setTimeout(function () { btn.textContent = old; }, 1600); }
  document.addEventListener('change', function (e) {
    var t = e.target, id = t.id;
    if (id === 'opt-warn') state.includeWarnings = t.checked;
    else if (id === 'opt-card') state.runCard = t.checked;
    else if (id === 'opt-grid') state.writeGrid = t.checked;
    else if (id === 'f-file') { state.file = t.value; state.limit = PAGE; render(); }
    else if (id === 'f-cat') { state.cat = t.value; state.limit = PAGE; render(); }
    else if (id === 'a-measure') { state.measure = t.value; render(); }
    else if (id === 'a-tol') { state.tol = Math.max(0, +t.value || 0); render(); }
    else if (id === 'a-hide') { state.hideEmpty = t.checked; render(); }
    else if (t.dataset && t.dataset.declared) { state.typed[t.dataset.declared + '|' + state.measure] = t.value; local.set('typed-' + state.run.folder, JSON.stringify(state.typed)); render(); }
    else if (id === 'req-ifc') { state.req.ver = +t.value; render(); }
    else if (id === 'req-phase') { state.req.phase = +t.value; render(); }
  });
  // Search boxes re-render while typing; put the caret back so typing is not interrupted.
  document.addEventListener('input', function (e) {
    var id = e.target.id;
    if (id !== 'f-q' && id !== 'req-search') return;
    if (id === 'f-q') { state.q = e.target.value; state.limit = PAGE; } else state.req.q = e.target.value.trim();
    var pos = e.target.selectionStart; render();
    var el = $(id); if (el) { el.focus(); try { el.setSelectionRange(pos, pos); } catch (err) {} }
  });
  var depth = 0;
  window.addEventListener('dragenter', function (e) { e.preventDefault(); depth++; var d = $('drop'); if (d) d.classList.add('over'); });
  window.addEventListener('dragleave', function () { depth = Math.max(0, depth - 1); var d = $('drop'); if (!depth && d) d.classList.remove('over'); });
  window.addEventListener('dragover', function (e) { e.preventDefault(); });
  window.addEventListener('drop', function (e) {
    e.preventDefault(); depth = 0; var d = $('drop'); if (d) d.classList.remove('over');
    if (state.view !== 'new' || state.running || !e.dataTransfer || !e.dataTransfer.files[0]) return;
    var p = dm.pathFor(e.dataTransfer.files[0]);
    if (/\.ifc$/i.test(p)) p = p.replace(/[\\/][^\\/]+$/, '');   // a dropped IFC file means "its folder"
    setFolder(p);
  });
  dm.onProgress(function (p) { state.progress = p; if (state.view === 'new') render(); });

  // ------------------------------------------------------------------ theme and start
  (function () {
    var root = document.documentElement, btn = $('theme');
    var saved = local.get('theme'), dark = saved ? saved === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
    var paint = function () { root.setAttribute('data-theme', dark ? 'dark' : 'light'); btn.textContent = dark ? 'Day mode' : 'Night mode'; };
    btn.addEventListener('click', function () { dark = !dark; local.set('theme', dark ? 'dark' : 'light'); paint(); });
    paint();
  })();
  function loadRules() {
    return dm.getRules().then(function (r) { state.rules = r; $('brand-sub').textContent = r ? 'DM BIM rules · IDS schema v' + r.schema : 'DM BIM rules'; });
  }
  dm.getSettings().then(function (s) { state.settings = s; state.runCard = !!s.cardPath; return loadRules(); }).then(function () {
    render();
    var last = local.get('folder'); if (last) setFolder(last);
  });
})();
