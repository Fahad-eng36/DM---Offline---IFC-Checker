/* DM QAQC Checker: desktop shell. Runs the Dubai Municipality QA/QC checker and building card generator
   on a folder of IFC files and hands their results to the window. All work stays on this computer. */
const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const QAQC_EXE = 'BIMToolkit.QAQCChecker.App.exe';
const CARD_EXE = 'BIMToolkit.BuildingCardGenerator.App.exe';
let win = null;
let running = null;          // the DM tool process of the check in progress

const userFile = (...p) => path.join(app.getPath('userData'), ...p);
const historyDir = () => { const d = userFile('history'); fs.mkdirSync(d, { recursive: true }); return d; };
const readJson = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return fallback; } };

// ---- settings -------------------------------------------------------------
function findTool(exe) {
  // Look where the DM zips are usually unpacked: next to the app, the user's folders and drive roots.
  const roots = [path.dirname(app.getPath('exe')), process.cwd(), app.getPath('documents'), app.getPath('downloads'), app.getPath('desktop'), 'C:\\', 'D:\\', 'D:\\DM BIM'];
  const sub = exe === QAQC_EXE ? 'dmbim.qaqcchecker' : 'dmbim.buildingcardgenerator';
  for (const r of roots) {
    for (const rel of [[sub], [sub, sub], ['dmbim.buildingcardgenerator', sub], ['DM BIM', sub], ['DM BIM', 'dmbim.buildingcardgenerator', sub]]) {
      const p = path.join(r, ...rel, exe);
      if (fs.existsSync(p)) return p;
    }
  }
  return '';
}
function settings() {
  const s = readJson(userFile('settings.json'), {});
  if (!s.qaqcPath || !fs.existsSync(s.qaqcPath)) s.qaqcPath = findTool(QAQC_EXE);
  if (!s.cardPath || !fs.existsSync(s.cardPath)) s.cardPath = findTool(CARD_EXE);
  return s;
}
function saveSettings(patch) {
  const s = Object.assign(readJson(userFile('settings.json'), {}), patch);
  fs.writeFileSync(userFile('settings.json'), JSON.stringify(s, null, 1));
  return settings();
}

// ---- csv ------------------------------------------------------------------
function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  text = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const head = (rows.shift() || []).map((h) => h.trim());
  return { head, rows: rows.filter((r) => r.length > 1 || (r[0] || '').trim()) };
}

// ---- running a DM tool ----------------------------------------------------
function listIfc(folder) {
  return fs.readdirSync(folder).filter((f) => /\.ifc$/i.test(f)).map((f) => ({ name: f, size: fs.statSync(path.join(folder, f)).size }));
}
function newestSince(dir, re, since, depth) {
  let best = null;
  const walk = (d, n) => {
    let list; try { list = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const f of list) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) { if (n > 0 && f.name !== 'node_modules') walk(p, n - 1); continue; }
      if (!re.test(f.name)) continue;
      const m = fs.statSync(p).mtimeMs;
      if (m >= since && (!best || m > best.m)) best = { p, m };
    }
  };
  walk(dir, depth);
  return best && best.p;
}
// doneEarly, when given, is asked every two seconds whether the tool has already produced what we need;
// if so the tool is stopped instead of waiting for it to exit.
function runTool(exe, answers, onLine, doneEarly) {
  return new Promise((resolve) => {
    const child = spawn(exe, [], { cwd: path.dirname(exe), windowsHide: true });
    running = child;
    let out = '', buf = '';
    const timer = doneEarly ? setInterval(() => { let ok = false; try { ok = doneEarly(); } catch (e) { /* keep waiting */ } if (ok) { clearInterval(timer); try { child.kill(); } catch (e) { /* already gone */ } } }, 2000) : null;
    child.on('close', () => { if (timer) clearInterval(timer); });
    const feed = (d) => {
      const s = d.toString('utf8'); out += s; buf += s;
      const lines = buf.split(/\r?\n/); buf = lines.pop();
      lines.forEach((l) => l.trim() && onLine(l.trim()));
    };
    child.stdout.on('data', feed); child.stderr.on('data', feed);
    child.on('error', (e) => { running = null; resolve({ code: -1, out: out + '\n' + e.message }); });
    child.on('close', (code) => { running = null; resolve({ code, out }); });
    try { child.stdin.write(answers.join('\r\n') + '\r\n\r\n\r\n'); child.stdin.end(); } catch (e) { /* the tool exited early */ }
  });
}
const send = (channel, data) => { if (win && !win.isDestroyed()) win.webContents.send(channel, data); };

function explain(out) {
  if (/building: -?\d+, model:-?\d+ are invalid/.test(out)) return 'The DM tool rejected a file name. IFC files must follow the DM convention, for example PN476511_BI000001_PA6184096_AR_001.ifc.';
  if (/Support for IFC2x3 has been withdrawn/i.test(out)) return 'The DM checker no longer accepts IFC2x3. Export the model as IFC4.';
  const ex = /Unhandled exception\.\s*([^\r\n]+)/.exec(out);
  return ex ? 'The DM tool stopped with an error: ' + ex[1] : '';
}

async function runCheck(opts) {
  const s = settings(), folder = opts.folder, started = Date.now();
  const files = listIfc(folder);
  if (!files.length) throw new Error('There are no .ifc files in ' + folder + '.');
  if (!s.qaqcPath) throw new Error('The DM QA/QC checker was not found. Set its location in Settings.');
  const run = { id: new Date(started).toISOString().replace(/[:.]/g, '-'), when: started, folder, files, includeWarnings: !!opts.includeWarnings, issues: [], resultsFile: '', card: null, notes: [] };

  // The DM tool writes QaQcResults.csv and then spends many more minutes, and several GB of memory, on
  // ModelInfoGrid.xlsx, which this app does not use. Unless that file is wanted, stop the tool once the
  // results file has been written and has stopped growing.
  let lastSize = -1, steady = 0;
  const resultsReady = () => {
    const f = newestSince(folder, /^QaQcResults.*\.csv$/i, started - 2000, 1);
    if (!f) return false;
    const size = fs.statSync(f).size;
    steady = size > 0 && size === lastSize ? steady + 1 : 0;
    lastSize = size;
    return steady >= 2;
  };
  let done = 0;
  send('check:progress', { stage: 'qaqc', text: 'Starting the DM QA/QC checker…', done: 0, total: files.length * 2 });
  const q = await runTool(s.qaqcPath, [folder, opts.includeWarnings ? 'N' : 'Y'], (line) => {
    // The tool opens every file, then checks every file: count both passes.
    let m;
    if ((m = /opening completed for: \[(.+?)\]/.exec(line))) { done++; send('check:progress', { stage: 'qaqc', text: 'Opened ' + path.basename(m[1]), done, total: files.length * 2 }); }
    else if ((m = /opening: \[(.+?)\]/.exec(line))) send('check:progress', { stage: 'qaqc', text: 'Opening ' + path.basename(m[1]), done, total: files.length * 2 });
    else if ((m = /END: content processing for (.+\.ifc)/i.exec(line))) { done++; send('check:progress', { stage: 'qaqc', text: 'Checked ' + path.basename(m[1]), done: Math.min(done, files.length * 2), total: files.length * 2 }); }
    else if ((m = /START: content processing for (.+\.ifc)/i.exec(line))) send('check:progress', { stage: 'qaqc', text: 'Checking ' + path.basename(m[1]), done, total: files.length * 2 });
  }, opts.writeGrid ? null : resultsReady);
  if (opts.cancelled && opts.cancelled()) throw new Error('The check was stopped.');
  const csv = newestSince(folder, /^QaQcResults.*\.csv$/i, started - 2000, 3) || newestSince(path.dirname(s.qaqcPath), /^QaQcResults.*\.csv$/i, started - 2000, 2);
  if (!csv) throw new Error(explain(q.out) || 'The DM QA/QC checker did not write a results file.\n\n' + q.out.split(/\r?\n/).slice(-8).join('\n'));
  run.resultsFile = csv;
  run.issues = readIssues(csv);
  send('check:progress', { stage: 'names', text: 'Looking up element names and Revit IDs…', done: 0, total: 0 });
  try { await resolveElements(folder, run.issues); } catch (e) { run.notes.push('Element names and Revit IDs could not be looked up: ' + e.message); }

  // Keep the checker's findings as soon as they exist, so a long check is not lost if the areas step fails or the app is closed.
  const save = () => { run.seconds = Math.round((Date.now() - started) / 1000); fs.writeFileSync(path.join(historyDir(), run.id + '.json'), JSON.stringify(run)); };
  save();

  if (opts.runCard && s.cardPath) {
    send('check:progress', { stage: 'card', text: 'Computing storey areas with the DM building card generator…', done: 0, total: 0 });
    const t = Date.now();
    const c = await runTool(s.cardPath, [folder], () => {});
    const zip = newestSince(path.join(folder, 'Temp'), /^Card_.*\.zip$/i, t - 2000, 0);
    if (zip) { try { run.card = readCard(zip); } catch (e) { run.notes.push('The building card could not be read: ' + e.message); } }
    else run.notes.push(explain(c.out) || 'The building card generator did not produce a card.');
  } else if (opts.runCard) run.notes.push('Storey areas were skipped: the DM building card generator was not found. Set its location in Settings.');

  run.seconds = Math.round((Date.now() - started) / 1000);
  fs.writeFileSync(path.join(historyDir(), run.id + '.json'), JSON.stringify(run));
  return run;
}

// Opens results the DM tools already wrote into a folder, without running them again.
async function importRun(folder) {
  const csv = newestSince(folder, /^QaQcResults.*\.csv$/i, 0, 1);
  if (!csv) throw new Error('There is no QaQcResults.csv in ' + folder + '.');
  const when = fs.statSync(csv).mtimeMs;
  const run = { id: new Date(when).toISOString().replace(/[:.]/g, '-') + '-opened', when, folder, files: listIfc(folder), includeWarnings: true, imported: true, issues: readIssues(csv), resultsFile: csv, card: null, notes: ['These results were written by the DM checker earlier and opened from the folder; the check was not run again.'] };
  run.includeWarnings = run.issues.some((i) => i.level === 'Warning') || !run.issues.length;
  try { await resolveElements(folder, run.issues); } catch (e) { /* names are optional */ }
  const zip = newestSince(path.join(folder, 'Temp'), /^Card_.*\.zip$/i, 0, 0);
  if (zip) { try { run.card = readCard(zip); } catch (e) { run.notes.push('The building card in this folder could not be read: ' + e.message); } }
  fs.writeFileSync(path.join(historyDir(), run.id + '.json'), JSON.stringify(run));
  return run;
}

// ---- the checker's results ------------------------------------------------
// QaQcResults.csv columns: SourceFile, Msg, ErrorLevel, Category, IsIDSMsg, EntityId, EntityIfcType.
function readIssues(csv) {
  const p = parseCsv(fs.readFileSync(csv, 'utf8'));
  const col = (re, fallback) => { const i = p.head.findIndex((h) => re.test(h)); return i >= 0 ? i : fallback; };
  const cFile = col(/^sourcefile$/i, 0), cMsg = col(/^msg|message/i, 1), cLevel = col(/level|severity/i, 2), cCat = col(/category/i, 3), cId = col(/^entityid$/i, 5), cType = col(/ifctype|entitytype/i, 6);
  return p.rows.map((r) => {
    const msg = r[cMsg] || '', g = /Entity \[([0-9A-Za-z_$]{22})\]/.exec(msg), label = parseInt(r[cId], 10);
    return { file: r[cFile] || '', msg, level: r[cLevel] || 'Other', category: r[cCat] || '', type: r[cType] || '', label: isFinite(label) && label > 0 ? label : null, guid: g ? g[1] : '', name: '', tag: '' };
  });
}
// The checker names an element only by its IFC line number and GlobalId. Read those lines from the IFC files
// to add the element's name and its Revit element ID (the IFC Tag).
function stepStrings(line) {
  const out = []; let i = line.indexOf('('), depth = 0, cur = null, n = line.length;
  for (i = i + 1; i < n; i++) {
    const c = line[i];
    if (c === "'") {
      let s = ''; i++;
      for (; i < n; i++) { if (line[i] === "'") { if (line[i + 1] === "'") { s += "'"; i++; } else break; } else s += line[i]; }
      if (depth === 0) cur = s;
    } else if (c === '(') depth++;
    else if (c === ')') { if (depth === 0) { out.push(cur); break; } depth--; }
    else if (c === ',' && depth === 0) { out.push(cur); cur = null; }
  }
  return out;
}
const decodeStep = (s) => (s || '').replace(/\\X2\\([0-9A-Fa-f]+)\\X0\\/g, (m, h) => h.replace(/.{4}/g, (x) => String.fromCharCode(parseInt(x, 16)))).replace(/\\X\\([0-9A-Fa-f]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
function resolveElements(folder, issues) {
  const byFile = new Map();
  for (const i of issues) if (i.label && i.file.indexOf(',') === -1) { if (!byFile.has(i.file)) byFile.set(i.file, new Map()); const m = byFile.get(i.file); if (!m.has(i.label)) m.set(i.label, []); m.get(i.label).push(i); }
  const jobs = [...byFile].map(([file, want]) => new Promise((resolve) => {
    const full = path.join(folder, file);
    if (!fs.existsSync(full)) return resolve();
    let buf = '', left = want.size;
    const stream = fs.createReadStream(full, { encoding: 'utf8', highWaterMark: 1 << 22 });
    const line = (l) => {
      if (l.charCodeAt(0) !== 35) return;
      const eq = l.indexOf('='); if (eq < 2 || eq > 12) return;
      const list = want.get(parseInt(l.slice(1, eq), 10)); if (!list) return;
      const a = stepStrings(l);
      list.forEach((i) => { i.name = decodeStep(a[2]) || ''; i.tag = /^\d+$/.test(a[7] || '') ? a[7] : ''; if (!i.guid && a[0]) i.guid = a[0]; });
      if (--left === 0) stream.destroy();
    };
    stream.on('data', (chunk) => { buf += chunk; const parts = buf.split('\n'); buf = parts.pop(); for (const l of parts) line(l); });
    stream.on('end', () => { if (buf) line(buf); resolve(); });
    stream.on('close', resolve); stream.on('error', resolve);
  }));
  return Promise.all(jobs);
}

// ---- rule file, for the Requirements screen -------------------------------
// attribute tuple: [propertySet, name, ifcReference, dataType, sample, userInput, phaseBits, description]
function rules() {
  const s = settings();
  const candidates = [s.qaqcPath, s.cardPath].filter(Boolean).map((p) => path.join(path.dirname(p), 'InfoDeliverySpecs', 'Resources', 'IDS.json'));
  const file = candidates.find((f) => fs.existsSync(f));
  if (!file) return null;
  const ids = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  let phases = null;
  const tuple = (a) => {
    if (!phases) phases = a.Phases.map((p) => p.Name);
    return [(a.PropertySet || '').trim(), a.Name || '', a.IfcReference || '', a.DataType || 'string', a.DataSample || '', a.UserInput !== false, a.Phases.map((p) => (p.IsRequired ? '1' : '0')).join(''), a.Description || ''];
  };
  const versions = ids.IfcVersionSchemas.map((v) => {
    const common = {};
    v.CommonSchemas.forEach((c) => { common[c.IfcType] = c.Attributes || []; });
    return { name: v.Name, groups: v.EntityGroups.map((g) => ({
      name: g.Name, type: g.IfcType, desc: g.Description || '',
      subs: (g.SubTypes || []).map((x) => [(x.PredefinedType || '').toUpperCase(), (x.ObjectTypeOverride || '').toUpperCase()]),
      attrs: (common[g.IfcType] || []).concat((g.SpecificSchema && g.SpecificSchema.Attributes) || []).map(tuple)
    })) };
  });
  return { schema: ids.SchemaVersion, phases, versions, file };
}

// ---- building card --------------------------------------------------------
function readCard(zip) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dmcard-'));
  try {
    const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    const x = spawnSync(tar, ['-xf', zip, '-C', work], { encoding: 'utf8', windowsHide: true });
    if (x.status !== 0) throw new Error(x.stderr || 'could not unpack the card');
    const storeysFile = newestSince(work, /-storeys\.csv$/i, 0, 3), spacesFile = newestSince(work, /-spaces\.csv$/i, 0, 3);
    if (!storeysFile) throw new Error('the card has no storeys file');
    const obj = (p) => p.rows.map((r) => Object.fromEntries(p.head.map((h, i) => [h, r[i]])));
    const num = (v) => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
    const man = (v) => { const n = parseFloat(v); return isFinite(n) && n >= 0 ? n : null; };   // the generator writes -1 for "not set"
    const yes = (v) => /^(true|yes)$/i.test(v || '');
    const storeys = obj(parseCsv(fs.readFileSync(storeysFile, 'utf8'))).map((s) => ({
      key: s.No + '|' + s.Name + '|' + s.BuildingPartNum, skey: s.No + '|' + s.Name, no: s.No, name: s.Name, part: s.BuildingPartNum,
      height: num(s.Height), invalid: yes(s.HasInvalidAreas), issues: s.Issues || '',
      buaA: num(s.BUA_Auto), buaM: man(s.BUA_Manual), gaA: num(s.GA_Auto), gaM: man(s.GA_Manual),
      gfaA: num(s.GFA_Auto), gfaM: man(s.GFA_Manual), naA: num(s.NA_Auto), naM: man(s.NA_Manual),
      wBua: num(s.WallsFootprintBuildUpArea), wGa: num(s.WallsFootprintGrossTotalArea), wGfa: num(s.WallsFootprintGrossFloorTotalArea),
      cols: num(s.ColsFootprintTotalArea), sBua: num(s.SpacesTotalBuildupArea), sGa: num(s.SpacesTotalGrossArea), sGfa: num(s.SpacesTotalGrossFloorArea)
    }));
    const spaces = {}; let spaceCount = 0;
    if (spacesFile) for (const p of obj(parseCsv(fs.readFileSync(spacesFile, 'utf8')))) {
      const bits = (yes(p.IncludedInBuildUpAreaCalc) ? 1 : 0) | (yes(p.IncludedInGrossAreaCalc) ? 2 : 0) | (yes(p.IncludedInNetAreaCalc) ? 4 : 0) | (yes(p.IncludedInGrossFloorAreaCalc) ? 8 : 0) | (yes(p.IsCovered) ? 16 : 0);
      const k = p.StoreyNo + '|' + p.StoreyName;
      (spaces[k] = spaces[k] || []).push([p.Name, p.ZoneObjectType || '', p.UnitNo || '', num(p.NetArea), num(p.GrossArea), bits, p.Issues || '']);
      spaceCount++;
    }
    return { storeys, spaces, spaceCount, multiPart: new Set(storeys.map((s) => s.part)).size > 1 };
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
}

// ---- window and messages --------------------------------------------------
function createWindow() {
  win = new BrowserWindow({
    width: 1360, height: 900, minWidth: 900, minHeight: 600, backgroundColor: '#16202B', autoHideMenuBar: true, title: 'DM QAQC Checker',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  win.loadFile(path.join(__dirname, 'app', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

ipcMain.handle('settings:get', () => settings());
ipcMain.handle('rules:get', () => { try { return rules(); } catch (e) { return null; } });
ipcMain.handle('settings:set', (e, patch) => saveSettings({ qaqcPath: String(patch.qaqcPath || ''), cardPath: String(patch.cardPath || '') }));
ipcMain.handle('pick:folder', async () => { const r = await dialog.showOpenDialog(win, { title: 'Folder with the IFC files', properties: ['openDirectory'] }); return r.canceled ? null : r.filePaths[0]; });
ipcMain.handle('pick:exe', async (e, title) => { const r = await dialog.showOpenDialog(win, { title: String(title || 'Choose the program'), properties: ['openFile'], filters: [{ name: 'Program', extensions: ['exe'] }] }); return r.canceled ? null : r.filePaths[0]; });
ipcMain.handle('folder:inspect', (e, folder) => { try { return { ok: fs.statSync(folder).isDirectory(), files: listIfc(folder), hasResults: !!newestSince(folder, /^QaQcResults.*\.csv$/i, 0, 1) }; } catch (err) { return { ok: false, files: [] }; } });
ipcMain.handle('check:import', async (e, folder) => { try { return { run: await importRun(String(folder)) }; } catch (err) { return { error: err.message }; } });
ipcMain.handle('check:run', async (e, opts) => {
  if (running) return { error: 'A check is already running.' };
  let cancelled = false; runCheck.cancel = () => { cancelled = true; };
  try { return { run: await runCheck({ folder: String(opts.folder), includeWarnings: !!opts.includeWarnings, runCard: !!opts.runCard, writeGrid: !!opts.writeGrid, cancelled: () => cancelled }) }; }
  catch (err) { return { error: err.message }; }
});
ipcMain.handle('check:stop', () => { if (runCheck.cancel) runCheck.cancel(); if (running) { try { running.kill(); } catch (e) { /* already gone */ } } return true; });
ipcMain.handle('history:list', () => fs.readdirSync(historyDir()).filter((f) => f.endsWith('.json')).map((f) => {
  const r = readJson(path.join(historyDir(), f), null);
  if (!r) return null;
  const counts = {};
  (r.issues || []).forEach((i) => { counts[i.level] = (counts[i.level] || 0) + 1; });
  return { id: r.id, when: r.when, folder: r.folder, files: r.files.length, issues: (r.issues || []).length, counts, includeWarnings: r.includeWarnings, hasCard: !!r.card, seconds: r.seconds };
}).filter(Boolean).sort((a, b) => b.when - a.when));
ipcMain.handle('history:get', (e, id) => readJson(path.join(historyDir(), path.basename(String(id)) + '.json'), null));
ipcMain.handle('history:delete', (e, id) => { try { fs.unlinkSync(path.join(historyDir(), path.basename(String(id)) + '.json')); } catch (err) { /* already gone */ } return true; });
ipcMain.handle('open:path', (e, p) => { if (typeof p === 'string' && fs.existsSync(p)) shell.showItemInFolder(p); return true; });
ipcMain.handle('save:csv', async (e, name, text) => {
  const r = await dialog.showSaveDialog(win, { title: 'Save as CSV', defaultPath: String(name || 'issues.csv'), filters: [{ name: 'CSV', extensions: ['csv'] }] });
  if (r.canceled) return null;
  fs.writeFileSync(r.filePath, '\uFEFF' + String(text));
  return r.filePath;
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (running) { try { running.kill(); } catch (e) { /* already gone */ } } app.quit(); });
