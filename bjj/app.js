/* ============================================================================
   Tatami — estudio de instruccionales de jiujitsu
   App 100% local: los videos nunca se suben a ningún lado; la app sólo guarda
   notas, tiempos (clips) y miniaturas en el propio teléfono (IndexedDB).
   ========================================================================== */

/* ---------------------------------------------------------------- utilidades */
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const DAY = 86400000;

const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** segundos -> "m:ss" o "h:mm:ss" */
function fmt(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
           : `${m}:${String(s).padStart(2, '0')}`;
}
/** "12:34" | "1:02:03" | "754" -> segundos */
function parseTime(txt) {
  if (txt == null) return null;
  const t = String(txt).trim();
  if (!t) return null;
  if (/^\d+$/.test(t)) return +t;
  const p = t.split(':').map(n => parseFloat(n));
  if (p.some(isNaN)) return null;
  return p.reduce((a, n) => a * 60 + n, 0);
}

let toastT;
function toast(msg, ms = 2200) {
  const el = $('#toast');
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => (el.hidden = true), ms);
}

/* ------------------------------------------------------------------ almacén */
const DB = (() => {
  const NAME = 'tatami-bjj', VER = 1;
  let db;

  function open() {
    if (db) return Promise.resolve(db);
    return new Promise((res, rej) => {
      const rq = indexedDB.open(NAME, VER);
      rq.onupgradeneeded = e => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains('inst')) d.createObjectStore('inst', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('parts')) {
          const s = d.createObjectStore('parts', { keyPath: 'id' });
          s.createIndex('instId', 'instId');
        }
        if (!d.objectStoreNames.contains('notes')) {
          const s = d.createObjectStore('notes', { keyPath: 'id' });
          s.createIndex('instId', 'instId');
          s.createIndex('partId', 'partId');
        }
        if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'k' });
      };
      rq.onsuccess = () => { db = rq.result; res(db); };
      rq.onerror = () => rej(rq.error);
    });
  }
  const run = (store, mode, fn) => open().then(d => new Promise((res, rej) => {
    const tx = d.transaction(store, mode), rq = fn(tx.objectStore(store));
    tx.onerror = () => rej(tx.error);
    tx.oncomplete = () => res(rq && rq.result);
  }));

  return {
    all:  s => run(s, 'readonly', st => st.getAll()),
    get:  (s, id) => run(s, 'readonly', st => st.get(id)),
    put:  (s, v) => run(s, 'readwrite', st => st.put(v)),
    del:  (s, id) => run(s, 'readwrite', st => st.delete(id)),
    clear: s => run(s, 'readwrite', st => st.clear()),
    by: (s, idx, val) => run(s, 'readonly', st => st.index(idx).getAll(val))
  };
})();

/* --------------------------------------------------------------- estado app */
const S = {
  inst: [], parts: [], notes: [],
  files: new Map(),        // partId -> {file, url}  (sólo en memoria, por sesión)
  player: null             // {partId, video, clip:{a,b}, loop}
};

const POSICIONES = ['—', 'Guardia cerrada', 'Guardia abierta', 'De la Riva', 'Media guardia',
  'Lasso / Spider', 'X-guard', 'Montada', 'Espalda', '100 kilos', 'Norte-sur', 'Rodilla en panza',
  'Tortuga', 'En pie / Takedowns', 'Pasaje de guardia', 'Barridas', 'Sumisiones', 'Escapes',
  'Defensa', 'Concepto / Teoría'];

const STATUS = {
  nuevo: { t: 'Por estudiar', c: 'st-nuevo' },
  drill: { t: 'Drilleando',   c: 'st-drill' },
  ok:    { t: 'Dominada',     c: 'st-ok' }
};

const PLANTILLA =
`Posición:
Objetivo:

Pasos:
1.
2.
3.

Detalles clave:
- 

Errores comunes:
- 

Reacciones del oponente / contras:
- `;

async function loadAll() {
  [S.inst, S.parts, S.notes] = await Promise.all([DB.all('inst'), DB.all('parts'), DB.all('notes')]);
  S.inst.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  S.parts.sort((a, b) => (a.order || 0) - (b.order || 0));
}

const partsOf = id => S.parts.filter(p => p.instId === id).sort((a, b) => (a.order || 0) - (b.order || 0));
const notesOf = id => S.notes.filter(n => n.instId === id).sort(cmpNote);
const notesOfPart = id => S.notes.filter(n => n.partId === id).sort((a, b) => (a.start || 0) - (b.start || 0));

function cmpNote(a, b) {
  const pa = S.parts.find(p => p.id === a.partId), pb = S.parts.find(p => p.id === b.partId);
  return ((pa?.order || 0) - (pb?.order || 0)) || ((a.start || 0) - (b.start || 0));
}

async function saveNote(n) {
  n.updatedAt = Date.now();
  await DB.put('notes', n);
  const i = S.notes.findIndex(x => x.id === n.id);
  i < 0 ? S.notes.push(n) : (S.notes[i] = n);
}
async function savePart(p) {
  await DB.put('parts', p);
  const i = S.parts.findIndex(x => x.id === p.id);
  i < 0 ? S.parts.push(p) : (S.parts[i] = p);
}
async function saveInst(x) {
  await DB.put('inst', x);
  const i = S.inst.findIndex(y => y.id === x.id);
  i < 0 ? S.inst.unshift(x) : (S.inst[i] = x);
}

/* ------------------------------------------------------------- hoja modal */
function sheet(title, html, after) {
  $('#sheetTitle').textContent = title;
  $('#sheetBody').innerHTML = html;
  $('#sheet').hidden = false;
  document.body.style.overflow = 'hidden';
  after && after($('#sheetBody'));
}
function closeSheet() {
  $('#sheet').hidden = true;
  $('#sheetBody').innerHTML = '';
  document.body.style.overflow = '';
  stopDictado();
}
$('#sheet').addEventListener('click', e => { if (e.target.hasAttribute('data-close')) closeSheet(); });

function confirmar(msg, onYes) {
  sheet('Confirmar', `<p>${esc(msg)}</p>
    <div class="row mt" style="gap:8px">
      <button class="btn grow" data-close>Cancelar</button>
      <button class="btn primary grow" id="cfYes">Sí, continuar</button>
    </div>`, body => $('#cfYes', body).onclick = () => { closeSheet(); onYes(); });
}

/* ------------------------------------------------------------------ router */
function go(hash) {
  const h = '#' + (hash.startsWith('/') ? hash : '/' + hash);
  if (location.hash === h) router(); else location.hash = h;
}

async function router() {
  const raw = location.hash.replace(/^#\/?/, '') || 'biblioteca';
  const [route, arg] = raw.split('/');
  const app = $('#app');
  app.scrollTop = 0; window.scrollTo(0, 0);
  destroyPlayer();

  $$('#tabbar a').forEach(a => a.classList.toggle('on',
    a.dataset.tab === route || (route === 'inst' && a.dataset.tab === 'biblioteca')
                            || (route === 'part' && a.dataset.tab === 'biblioteca')
                            || (route === 'note' && a.dataset.tab === 'biblioteca')));
  $('#topAction').hidden = true;
  $('#backBtn').hidden = ['biblioteca', 'repaso', 'buscar', 'ajustes'].includes(route);

  const views = {
    biblioteca: viewBiblioteca, inst: viewInst, part: viewPart,
    note: viewNote, repaso: viewRepaso, buscar: viewBuscar, ajustes: viewAjustes
  };
  (views[route] || viewBiblioteca)(app, arg);
}

$('#backBtn').onclick = () => history.length > 1 ? history.back() : go('/biblioteca');
window.addEventListener('hashchange', router);

/* ======================================================================== */
/*  BIBLIOTECA                                                              */
/* ======================================================================== */
function statPct(id) {
  const ns = notesOf(id);
  if (!ns.length) return 0;
  return Math.round(ns.filter(n => n.status === 'ok').length / ns.length * 100);
}

function viewBiblioteca(app) {
  $('#title').textContent = 'Mis instruccionales';
  const due = dueNotes().length;

  app.innerHTML = `
    ${due ? `<a href="#/repaso" class="card tap row between" style="border-color:#3a2b2b">
        <div><strong>Repaso de hoy</strong><div class="sm dim">${due} ficha${due > 1 ? 's' : ''} esperándote</div></div>
        <span class="chip on">${due}</span></a>` : ''}

    ${S.inst.length ? S.inst.map(i => {
      const ps = partsOf(i.id), ns = notesOf(i.id), pct = statPct(i.id);
      return `<a class="card tap" href="#/inst/${i.id}">
        <div class="row between">
          <div class="grow">
            <strong class="trunc">${esc(i.title)}</strong>
            <div class="sm dim trunc">${esc(i.instructor || 'Sin instructor')}</div>
          </div>
          <span class="chip">${ns.length} fichas</span>
        </div>
        <div class="row mt sm dim" style="gap:8px">
          <span>${ps.length} parte${ps.length === 1 ? '' : 's'}</span><span>·</span><span>${pct}% dominado</span>
        </div>
        <div class="bar mt"><i style="width:${pct}%"></i></div>
      </a>`;
    }).join('') : `<div class="empty">
        <div class="big">&#129354;</div>
        <p>Todavía no tienes instruccionales.<br>Crea el primero y empieza a desmenuzarlo.</p>
      </div>`}

    <button class="btn primary wide mt" id="newInst">+ Nuevo instruccional</button>
    ${!S.inst.length ? `<div class="hint mt">
       <strong>Cómo funciona</strong><br>
       1. Creas el instruccional y agregas sus partes (los videos que tienes en el celular).<br>
       2. Pegas el temario con tiempos de BJJ Fanatics y la app arma una ficha por técnica, cada una con su clip.<br>
       3. Ves el clip, dictas o escribes tus notas, y capturas una foto del momento clave.<br>
       Tus videos nunca se suben a internet: la app los abre desde tu propio teléfono.
     </div>` : ''}`;

  $('#newInst').onclick = () => editInst(null);
}

function editInst(inst) {
  const n = inst || { id: uid(), title: '', instructor: '', url: '', createdAt: Date.now() };
  sheet(inst ? 'Editar instruccional' : 'Nuevo instruccional', `
    <label class="f">Título</label>
    <input type="text" id="fTitle" value="${esc(n.title)}" placeholder="Ej. Just Stand Up — Craig Jones">
    <label class="f">Instructor</label>
    <input type="text" id="fIns" value="${esc(n.instructor)}" placeholder="Ej. Gordon Ryan">
    <label class="f">Link en BJJ Fanatics (opcional)</label>
    <input type="text" id="fUrl" value="${esc(n.url || '')}" placeholder="https://bjjfanatics.com/...">
    <button class="btn primary wide mt" id="okI">Guardar</button>
    ${inst ? `<button class="btn ghost wide mt" id="delI" style="color:var(--acc)">Eliminar instruccional</button>` : ''}
  `, body => {
    $('#okI', body).onclick = async () => {
      n.title = $('#fTitle', body).value.trim() || 'Sin título';
      n.instructor = $('#fIns', body).value.trim();
      n.url = $('#fUrl', body).value.trim();
      await saveInst(n); closeSheet();
      inst ? router() : go('/inst/' + n.id);
    };
    const d = $('#delI', body);
    if (d) d.onclick = () => confirmar('Se borrarán sus partes y todas sus fichas. ¿Seguro?', async () => {
      for (const p of partsOf(n.id)) await DB.del('parts', p.id);
      for (const x of notesOf(n.id)) await DB.del('notes', x.id);
      await DB.del('inst', n.id);
      await loadAll(); go('/biblioteca'); toast('Instruccional eliminado');
    });
  });
}

/* ======================================================================== */
/*  INSTRUCCIONAL                                                           */
/* ======================================================================== */
function viewInst(app, id) {
  const inst = S.inst.find(i => i.id === id);
  if (!inst) return go('/biblioteca');
  $('#title').textContent = inst.title;
  const act = $('#topAction');
  act.hidden = false; act.textContent = '✎';
  act.onclick = () => editInst(inst);

  const ps = partsOf(id), ns = notesOf(id);
  app.innerHTML = `
    <div class="card">
      <div class="row between">
        <div class="grow"><strong>${esc(inst.instructor || 'Instruccional')}</strong>
          <div class="sm dim">${ns.length} fichas · ${statPct(id)}% dominado</div></div>
      </div>
      ${inst.url ? `<a class="sm mt" style="display:block;color:#8ab4f8" href="${esc(inst.url)}" target="_blank" rel="noopener">Ver en BJJ Fanatics &#8599;</a>` : ''}
      <div class="row mt wrap" style="gap:8px">
        <button class="btn sm" id="addPart">+ Parte</button>
        <button class="btn sm" id="impAll">Pegar temario</button>
        <button class="btn sm" id="expInst">Exportar notas</button>
      </div>
    </div>

    <h3 class="mb" style="font-size:14px">Partes</h3>
    ${ps.length ? ps.map(p => {
      const c = notesOfPart(p.id).length, linked = S.files.has(p.id);
      return `<a class="card tap row between" href="#/part/${p.id}">
        <div class="grow">
          <strong class="trunc">${esc(p.title)}</strong>
          <div class="sm dim trunc">${c} ficha${c === 1 ? '' : 's'}${p.duration ? ' · ' + fmt(p.duration) : ''}${p.fileName ? ' · ' + esc(p.fileName) : ''}</div>
        </div>
        <span class="chip ${linked ? 'on' : ''}">${linked ? 'video listo' : 'vincular'}</span>
      </a>`;
    }).join('') : `<div class="empty sm">Agrega las partes del instruccional (uno por archivo de video).</div>`}

    ${ns.length ? `<h3 class="mb mt" style="font-size:14px">Todas las fichas</h3>
      ${ns.map(noteCard).join('')}` : ''}`;

  $('#addPart').onclick = () => editPart(null, id);
  $('#impAll').onclick = () => importarTemario(id, ps[0]?.id);
  $('#expInst').onclick = () => exportSheet(id);
}

function editPart(part, instId) {
  const ps = partsOf(instId || part.instId);
  const p = part || { id: uid(), instId, title: '', order: ps.length + 1 };
  sheet(part ? 'Editar parte' : 'Nueva parte', `
    <label class="f">Nombre de la parte</label>
    <input type="text" id="pT" value="${esc(p.title)}" placeholder="Ej. Parte 1 — Fundamentos">
    <label class="f">Orden</label>
    <input type="number" id="pO" value="${p.order}" min="1">
    <button class="btn primary wide mt" id="okP">Guardar</button>
    ${part ? `<button class="btn ghost wide mt" id="delP" style="color:var(--acc)">Eliminar parte</button>` : ''}
  `, body => {
    $('#okP', body).onclick = async () => {
      p.title = $('#pT', body).value.trim() || ('Parte ' + p.order);
      p.order = +$('#pO', body).value || 1;
      await savePart(p); closeSheet(); router();
    };
    const d = $('#delP', body);
    if (d) d.onclick = () => confirmar('Se borrarán también las fichas de esta parte. ¿Seguro?', async () => {
      for (const x of notesOfPart(p.id)) await DB.del('notes', x.id);
      await DB.del('parts', p.id);
      await loadAll(); go('/inst/' + p.instId); toast('Parte eliminada');
    });
  });
}

/* ======================================================================== */
/*  TEMARIO (tiempos de BJJ Fanatics)                                       */
/* ======================================================================== */
/** Extrae capítulos de un texto pegado. Acepta líneas del tipo:
 *  "12:34 Armbar desde la guardia" · "1. Armbar - 12:34" · "12:34 - 15:02 Armbar"  */
function parseTemario(text) {
  const TS = /\b(\d{1,2}:\d{2}(?::\d{2})?)\b/g;
  const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const times = line.match(TS);
    if (!times) continue;
    const start = parseTime(times[0]);
    const end = times[1] ? parseTime(times[1]) : null;
    let title = line.replace(TS, ' ')
      .replace(/^[\s.\-–—|·:)\]]*\d{1,3}[).\-–]\s*/, ' ')   // "12." al inicio
      .replace(/[\-–—|·]{1,}/g, ' ')
      .replace(/\(\s*\)|\[\s*\]/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .replace(/^[\s.:\-–—|·]+|[\s.:\-–—|·]+$/g, '')
      .trim();
    if (!title) title = 'Técnica ' + fmt(start);
    out.push({ title, start, end });
  }
  out.sort((a, b) => a.start - b.start);
  for (let i = 0; i < out.length; i++)
    if (out[i].end == null) out[i].end = out[i + 1] ? out[i + 1].start : out[i].start + 120;
  return out;
}

function importarTemario(instId, partIdDefault) {
  const ps = partsOf(instId);
  if (!ps.length) return toast('Primero agrega una parte');
  sheet('Pegar temario con tiempos', `
    <div class="hint mb">Abre el instruccional en <b>bjjfanatics.com</b>, copia la lista de técnicas con sus tiempos y pégala aquí.
    La app crea una ficha por técnica, con su clip ya recortado.</div>
    <label class="f">Parte a la que pertenecen</label>
    <select id="tPart">${ps.map(p => `<option value="${p.id}" ${p.id === partIdDefault ? 'selected' : ''}>${esc(p.title)}</option>`).join('')}</select>
    <label class="f">Temario</label>
    <textarea id="tTxt" style="min-height:190px" placeholder="0:00 Introducción
3:45 Armbar desde guardia cerrada
9:12 Detalle del ángulo de cadera"></textarea>
    <div class="row mt" style="gap:8px">
      <button class="btn grow" id="tPrev">Previsualizar</button>
      <button class="btn primary grow" id="tOk" disabled>Crear fichas</button>
    </div>
    <div id="tOut" class="mt"></div>
  `, body => {
    let caps = [];
    $('#tPrev', body).onclick = () => {
      caps = parseTemario($('#tTxt', body).value);
      $('#tOut', body).innerHTML = caps.length
        ? `<div class="sm dim mb">${caps.length} técnicas detectadas:</div>` +
          caps.map(c => `<div class="row sm" style="gap:8px"><span class="mono dim">${fmt(c.start)}</span><span class="grow trunc">${esc(c.title)}</span></div>`).join('')
        : `<div class="sm" style="color:var(--acc)">No encontré tiempos. Cada línea necesita algo como 12:34.</div>`;
      $('#tOk', body).disabled = !caps.length;
    };
    $('#tOk', body).onclick = async () => {
      const partId = $('#tPart', body).value;
      const dur = S.parts.find(p => p.id === partId)?.duration || 0;
      for (const c of caps) {
        if (dur) c.end = Math.min(c.end, dur);
        await saveNote({
          id: uid(), instId, partId, title: c.title, start: c.start, end: c.end,
          body: '', keyPoints: [], tags: [], position: '', status: 'nuevo', thumb: '',
          srs: { due: Date.now(), interval: 0, reps: 0 }, createdAt: Date.now()
        });
      }
      closeSheet(); toast(`${caps.length} fichas creadas`); go('/part/' + partId);
    };
  });
}

/* ======================================================================== */
/*  SUBTÍTULOS -> NOTAS AUTOMÁTICAS                                         */
/* ======================================================================== */
/** Lee un .srt o .vtt y devuelve [{a, b, txt}] en segundos. */
function parseSubs(text) {
  const T = String(text).replace(/\r/g, '');
  const TS = '(?:\\d{1,3}:)?\\d{1,2}:\\d{2}[.,]\\d{1,3}';
  const re = new RegExp('(' + TS + ')\\s*-->\\s*(' + TS + ')[^\\n]*\\n([\\s\\S]*?)(?=\\n\\s*\\n|$)', 'g');
  const sec = t => {
    const p = t.replace(',', '.').split(':').map(parseFloat);
    return p.reduce((a, n) => a * 60 + n, 0);
  };
  const out = [];
  let m;
  while ((m = re.exec(T))) {
    const txt = m[3].replace(/<[^>]*>/g, '').replace(/\{[^}]*\}/g, '')
                    .split('\n').map(s => s.trim()).filter(Boolean).join(' ').trim();
    if (txt) out.push({ a: sec(m[1]), b: sec(m[2]), txt });
  }
  return out;
}

/** Junta el texto de los subtítulos que caen dentro de un rango. */
function textoEnRango(cues, a, b) {
  const trozos = [];
  for (const c of cues) {
    if (c.b <= a || c.a >= b) continue;
    const t = c.txt;
    if (t && t !== trozos[trozos.length - 1]) trozos.push(t);
  }
  return trozos.join(' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/([.?!])\s+/g, '$1\n')
    .trim();
}

function importarSubs(part) {
  const ns = notesOfPart(part.id);
  sheet('Subtítulos de esta parte', `
    <div class="hint mb">Si el instruccional trae archivo de subtítulos (<b>.srt</b> o <b>.vtt</b>),
    la app reparte lo que dice el instructor dentro de la ficha de cada técnica. Así tus notas
    se escriben solas y luego tú las resumes.</div>
    ${ns.length ? `<div class="sm dim mb">${ns.length} fichas en «${esc(part.title)}»</div>`
                : `<div class="sm mb" style="color:var(--acc)">Primero crea las fichas (pega el temario).</div>`}
    <label class="row" style="gap:9px; align-items:center">
      <input type="checkbox" id="sOver" style="width:auto"> <span class="sm">Reemplazar las notas que ya escribí</span>
    </label>
    <button class="btn primary wide mt" id="sPick" ${ns.length ? '' : 'disabled'}>Elegir archivo .srt o .vtt</button>
    <div id="sOut" class="mt"></div>
  `, body => {
    $('#sPick', body).onclick = () => {
      const inp = $('#subPicker'); inp.value = '';
      inp.onchange = async () => {
        const f = inp.files[0]; if (!f) return;
        let cues = [];
        try { cues = parseSubs(await f.text()); } catch (e) {}
        if (!cues.length) { $('#sOut', body).innerHTML = '<div class="sm" style="color:var(--acc)">No pude leer subtítulos en ese archivo.</div>'; return; }
        const over = $('#sOver', body).checked;
        let n = 0;
        for (const nota of notesOfPart(part.id)) {
          const txt = textoEnRango(cues, nota.start, nota.end);
          if (!txt) continue;
          if (nota.body && !over) continue;
          nota.body = txt;
          await saveNote(nota); n++;
        }
        $('#sOut', body).innerHTML = `<div class="sm">${cues.length} líneas leídas · <b>${n} fichas</b> con notas automáticas.</div>`;
        toast(n + ' fichas escritas desde los subtítulos');
        setTimeout(() => { closeSheet(); router(); }, 1200);
      };
      inp.click();
    };
  });
}

/* ======================================================================== */
/*  REPRODUCTOR + CLIPS                                                     */
/* ======================================================================== */
function destroyPlayer() {
  if (S.player) {
    // Un <video> ya desprendido del DOM sigue emitiendo eventos si no se pausa.
    try { S.player.video.pause(); } catch (e) {}
    S.player = null;
  }
}

/** Abre el selector de archivos del teléfono y devuelve el File elegido. */
function pickFile() {
  return new Promise(res => {
    const inp = $('#filePicker');
    inp.value = '';
    inp.onchange = () => { const f = inp.files[0] || null; inp.onchange = null; res(f); };
    inp.click();
  });
}

async function linkVideo(part) {
  // En escritorio (Chrome/Edge) el permiso se puede recordar entre sesiones.
  if (window.showOpenFilePicker) {
    try {
      const [h] = await window.showOpenFilePicker({
        types: [{ description: 'Video', accept: { 'video/*': ['.mp4', '.mkv', '.mov', '.webm', '.avi'] } }]
      });
      const f = await h.getFile();
      part.handle = h; part.fileName = f.name; await savePart(part);
      setFile(part.id, f); return f;
    } catch (e) { if (e && e.name === 'AbortError') return null; }
  }
  const f = await pickFile();
  if (!f) return null;
  part.fileName = f.name; await savePart(part);
  setFile(part.id, f);
  return f;
}

function setFile(partId, file) {
  const old = S.files.get(partId);
  if (old) URL.revokeObjectURL(old.url);
  S.files.set(partId, { file, url: URL.createObjectURL(file) });
}

/** Reintenta abrir el archivo guardado (sólo escritorio, con permiso vigente). */
async function tryRelink(part) {
  if (S.files.has(part.id) || !part.handle) return false;
  try {
    const perm = await part.handle.queryPermission({ mode: 'read' });
    if (perm !== 'granted' && await part.handle.requestPermission({ mode: 'read' }) !== 'granted') return false;
    setFile(part.id, await part.handle.getFile());
    return true;
  } catch (e) { return false; }
}

function grabThumb(video, w = 320) {
  try {
    const c = document.createElement('canvas');
    const ratio = (video.videoHeight / video.videoWidth) || 0.5625;
    c.width = w; c.height = Math.round(w * ratio);
    c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.62);
  } catch (e) { return ''; }
}

async function viewPart(app, partId) {
  const part = S.parts.find(p => p.id === partId);
  if (!part) return go('/biblioteca');
  const inst = S.inst.find(i => i.id === part.instId);
  $('#title').textContent = part.title;
  const act = $('#topAction'); act.hidden = false; act.textContent = '✎';
  act.onclick = () => editPart(part);

  await tryRelink(part);
  const linked = S.files.get(part.id);
  const ns = notesOfPart(part.id);

  app.innerHTML = `
    ${linked ? `
      <div class="player"><video id="vid" playsinline preload="metadata" src="${linked.url}"></video></div>
      <div class="pbar">
        <div class="times sm dim"><span id="tCur" class="mono">0:00</span><span id="tDur" class="mono">--:--</span></div>
        <input type="range" id="seek" min="0" max="1000" value="0" step="1">
        <div class="abbar"><i id="abFill" style="left:0;width:0"></i></div>
        <div class="pctl mt">
          <button class="btn sm" id="b10">&#8630; 10</button>
          <button class="btn sm primary" id="bPlay" style="min-width:64px">&#9654;</button>
          <button class="btn sm" id="f10">10 &#8631;</button>
          <button class="btn sm" id="bSpd">1x</button>
          <button class="btn sm" id="bLoop">&#8635; clip</button>
        </div>
        <div class="pctl mt">
          <button class="btn sm" id="bA">Inicio &#9678;</button>
          <button class="btn sm" id="bB">Fin &#9678;</button>
          <button class="btn sm primary" id="bNew">+ Ficha del clip</button>
        </div>
        <div class="sm dim center mt" id="clipInfo">Clip: —</div>
      </div>`
    : `<div class="card center">
        <div class="sm dim mb">Esta parte todavía no tiene su video vinculado.</div>
        <button class="btn primary wide" id="bLink">Elegir video del teléfono</button>
        <div class="xs dim mt">El archivo no se sube a ningún lado: sólo se abre desde tu almacenamiento.
        ${part.fileName ? '<br>Última vez usaste: <b>' + esc(part.fileName) + '</b>' : ''}</div>
      </div>`}

    <div class="row between mb mt">
      <h3 style="font-size:14px">Fichas de esta parte (${ns.length})</h3>
      <button class="btn sm" id="bImp">Temario</button>
      <button class="btn sm" id="bSub">Subtítulos</button>
    </div>
    ${ns.length ? ns.map(noteCard).join('')
      : `<div class="empty sm">Sin fichas. Pega el temario de BJJ Fanatics o marca inicio/fin en el video y toca “+ Ficha del clip”.</div>`}
    ${linked ? '' : '<div class="hint mt">Puedes crear y leer fichas sin el video; sólo necesitas vincularlo para ver los clips.</div>'}
  `;

  $('#bImp').onclick = () => importarTemario(part.instId, part.id);
  $('#bSub').onclick = () => importarSubs(part);
  const bl = $('#bLink');
  if (bl) bl.onclick = async () => { const f = await linkVideo(part); if (f) router(); };
  if (linked) setupPlayer(part, inst);
}

function setupPlayer(part, inst) {
  const v = $('#vid');
  const P = S.player = { partId: part.id, video: v, a: null, b: null, loop: true };
  const speeds = [1, 1.25, 1.5, 0.75, 0.5];
  let si = 0;

  const info = () => {
    if (!$('#clipInfo')) return;
    $('#clipInfo').textContent = (P.a != null || P.b != null)
      ? `Clip: ${P.a != null ? fmt(P.a) : '—'} → ${P.b != null ? fmt(P.b) : '—'}`
      : 'Clip: marca Inicio y Fin, o toca una ficha';
    const d = v.duration || part.duration || 0;
    const fill = $('#abFill');
    if (d && P.a != null && P.b != null) {
      fill.style.left = (P.a / d * 100) + '%';
      fill.style.width = Math.max(1, (P.b - P.a) / d * 100) + '%';
    } else { fill.style.width = '0'; }
  };

  /** Los handlers sólo actúan si este reproductor sigue siendo el vigente. */
  const vivo = () => S.player === P && v.isConnected;

  v.addEventListener('loadedmetadata', async () => {
    if (!vivo()) return;
    $('#tDur').textContent = fmt(v.duration);
    if (!part.duration || Math.abs(part.duration - v.duration) > 2) {
      part.duration = v.duration; await savePart(part);
    }
    if (S.pending) { applyPending(); }
  });
  v.addEventListener('timeupdate', () => {
    if (!vivo()) return;
    $('#tCur').textContent = fmt(v.currentTime);
    if (v.duration) $('#seek').value = Math.round(v.currentTime / v.duration * 1000);
    if (P.loop && P.b != null && v.currentTime >= P.b) {
      if (P.a != null) v.currentTime = P.a; else v.pause();
    }
  });
  v.addEventListener('play',  () => { if (vivo()) $('#bPlay').innerHTML = '&#10074;&#10074;'; });
  v.addEventListener('pause', () => { if (vivo()) $('#bPlay').innerHTML = '&#9654;'; });

  $('#seek').oninput = e => { if (v.duration) v.currentTime = e.target.value / 1000 * v.duration; };
  $('#bPlay').onclick = () => v.paused ? v.play() : v.pause();
  $('#b10').onclick = () => v.currentTime = Math.max(0, v.currentTime - 10);
  $('#f10').onclick = () => v.currentTime = Math.min(v.duration || 1e9, v.currentTime + 10);
  $('#bSpd').onclick = e => { si = (si + 1) % speeds.length; v.playbackRate = speeds[si]; e.target.textContent = speeds[si] + 'x'; };
  $('#bLoop').onclick = e => { P.loop = !P.loop; e.target.style.opacity = P.loop ? 1 : .45; toast(P.loop ? 'Repetir clip: activado' : 'Repetir clip: apagado'); };
  $('#bA').onclick = () => { P.a = v.currentTime; if (P.b != null && P.b <= P.a) P.b = null; info(); toast('Inicio en ' + fmt(P.a)); };
  $('#bB').onclick = () => { P.b = v.currentTime; if (P.a == null) P.a = Math.max(0, P.b - 60); info(); toast('Fin en ' + fmt(P.b)); };
  $('#bNew').onclick = () => editNote(null, {
    instId: part.instId, partId: part.id,
    start: P.a != null ? P.a : Math.max(0, v.currentTime - 15),
    end: P.b != null ? P.b : v.currentTime + 45,
    thumb: grabThumb(v)
  });

  info();
  if (S.pending) applyPending();

  function applyPending() {
    const p = S.pending; if (!p) return;
    if (!v.duration) return;              // esperamos a loadedmetadata
    S.pending = null;
    P.a = p.a ?? null; P.b = p.b ?? null;
    v.currentTime = p.a ?? 0;
    info();
    if (p.play) v.play().catch(() => toast('Toca ▶ para reproducir'));
    $('.player').scrollIntoView({ block: 'start' });
  }
}

/** Salta a un clip: abre la parte del video en el rango de la ficha. */
function playClip(note, autoplay = true) {
  const part = S.parts.find(p => p.id === note.partId);
  if (!part) return toast('Esa ficha no tiene parte');
  S.pending = { a: note.start, b: note.end, play: autoplay };
  if (S.player && S.player.partId === part.id) { go('/part/' + part.id); }
  else go('/part/' + part.id);
}

/* ======================================================================== */
/*  FICHAS                                                                  */
/* ======================================================================== */
function noteCard(n) {
  const st = STATUS[n.status] || STATUS.nuevo;
  const part = S.parts.find(p => p.id === n.partId);
  return `<a class="card tap" href="#/note/${n.id}">
    <div class="row" style="gap:10px; align-items:flex-start">
      ${n.thumb ? `<img class="thumb" src="${n.thumb}" alt="">`
                : `<div class="thumb ph">&#9654;</div>`}
      <div class="grow">
        <strong class="trunc" style="display:block">${esc(n.title)}</strong>
        <div class="sm dim mono">${fmt(n.start)} – ${fmt(n.end)}${part ? ' · ' + esc(part.title) : ''}</div>
        <div class="chips mt">
          <span class="st ${st.c}">${st.t}</span>
          ${n.position ? `<span class="chip">${esc(n.position)}</span>` : ''}
          ${(n.tags || []).slice(0, 2).map(t => `<span class="chip t">${esc(t)}</span>`).join('')}
        </div>
      </div>
    </div>
  </a>`;
}

function viewNote(app, id) {
  const n = S.notes.find(x => x.id === id);
  if (!n) return go('/biblioteca');
  const part = S.parts.find(p => p.id === n.partId);
  const inst = S.inst.find(i => i.id === n.instId);
  $('#title').textContent = n.title;
  const act = $('#topAction'); act.hidden = false; act.textContent = '✎';
  act.onclick = () => editNote(n);
  const st = STATUS[n.status] || STATUS.nuevo;

  app.innerHTML = `
    <div class="card">
      ${n.thumb ? `<img class="thumb big mb" src="${n.thumb}" alt="">` : ''}
      <div class="row between wrap" style="gap:8px">
        <span class="st ${st.c}">${st.t}</span>
        <span class="sm dim mono">${fmt(n.start)} – ${fmt(n.end)} (${fmt(Math.max(0, n.end - n.start))})</span>
      </div>
      <div class="sm dim mt">${esc(inst?.title || '')}${part ? ' · ' + esc(part.title) : ''}</div>
      <button class="btn primary wide mt" id="bClip">&#9654; Ver el clip</button>
    </div>

    ${n.body ? `<div class="card"><div class="note-body">${esc(n.body)}</div></div>` : ''}
    ${(n.keyPoints || []).length ? `<div class="card">
        <strong class="sm">Detalles clave</strong>
        <ul class="kp">${n.keyPoints.map(k => `<li>${esc(k)}</li>`).join('')}</ul>
      </div>` : ''}
    ${(n.tags || []).length || n.position ? `<div class="card chips">
        ${n.position ? `<span class="chip">${esc(n.position)}</span>` : ''}
        ${(n.tags || []).map(t => `<span class="chip t">${esc(t)}</span>`).join('')}
      </div>` : ''}

    <div class="card">
      <strong class="sm">Estado</strong>
      <div class="row mt" style="gap:8px">
        ${Object.entries(STATUS).map(([k, s]) =>
          `<button class="btn sm grow ${n.status === k ? 'primary' : ''}" data-st="${k}">${s.t}</button>`).join('')}
      </div>
      <div class="xs dim mt">Próximo repaso: ${n.srs?.due ? new Date(n.srs.due).toLocaleDateString('es-MX') : 'hoy'}</div>
    </div>

    <button class="btn ghost wide" id="bDel" style="color:var(--acc)">Eliminar ficha</button>`;

  $('#bClip').onclick = () => playClip(n);
  $$('[data-st]').forEach(b => b.onclick = async () => {
    n.status = b.dataset.st; await saveNote(n); router();
  });
  $('#bDel').onclick = () => confirmar('¿Eliminar esta ficha?', async () => {
    await DB.del('notes', n.id);
    S.notes = S.notes.filter(x => x.id !== n.id);
    go('/part/' + n.partId); toast('Ficha eliminada');
  });
}

/* --------------------------------------------------------- editor de ficha */
let REC = null;
function stopDictado() {
  if (REC) { try { REC.stop(); } catch (e) {} REC = null; }
  $$('.rec').forEach(b => b.classList.remove('rec'));
}
function dictado(ta, btn) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return toast('Este navegador no permite dictado por voz');
  if (REC) { stopDictado(); return; }
  const r = REC = new SR();
  r.lang = 'es-MX'; r.continuous = true; r.interimResults = false;
  btn.classList.add('rec');
  r.onresult = e => {
    let txt = '';
    for (let i = e.resultIndex; i < e.results.length; i++)
      if (e.results[i].isFinal) txt += e.results[i][0].transcript;
    if (!txt) return;
    ta.value += (ta.value && !/\s$/.test(ta.value) ? ' ' : '') + txt.trim();
    ta.scrollTop = ta.scrollHeight;
  };
  r.onerror = () => { toast('No pude escuchar. Revisa el permiso del micrófono.'); stopDictado(); };
  r.onend = () => { if (REC === r) { btn.classList.remove('rec'); REC = null; } };
  r.start();
  toast('Dictando… toca de nuevo para parar');
}

function editNote(note, d = {}) {
  const nueva = !note;
  const n = note || {
    id: uid(), instId: d.instId, partId: d.partId, title: '',
    start: Math.max(0, Math.round(d.start || 0)), end: Math.round(d.end || 0),
    body: '', keyPoints: [], tags: [], position: '', status: 'nuevo',
    thumb: d.thumb || '', srs: { due: Date.now(), interval: 0, reps: 0 }, createdAt: Date.now()
  };
  const live = S.player && S.player.partId === n.partId ? S.player.video : null;

  sheet(nueva ? 'Nueva ficha' : 'Editar ficha', `
    ${n.thumb ? `<img class="thumb big mb" id="thPrev" src="${n.thumb}" alt="">` : ''}
    <label class="f">Técnica o concepto</label>
    <input type="text" id="nT" value="${esc(n.title)}" placeholder="Ej. Estrangulamiento desde la espalda">

    <label class="f">Clip (inicio – fin)</label>
    <div class="row" style="gap:8px">
      <input type="text" id="nA" class="mono" value="${fmt(n.start)}" placeholder="0:00">
      <input type="text" id="nB" class="mono" value="${fmt(n.end)}" placeholder="0:00">
    </div>
    ${live ? `<div class="row mt" style="gap:8px">
        <button class="btn sm grow" id="useA">Inicio = ahora</button>
        <button class="btn sm grow" id="useB">Fin = ahora</button>
        <button class="btn sm grow" id="snap">&#128247; Foto</button>
      </div>` : ''}

    <label class="f">Posición</label>
    <select id="nP">${POSICIONES.map(p => `<option ${((n.position || '—') === p) ? 'selected' : ''}>${p}</option>`).join('')}</select>

    <label class="f">Notas <span class="dim">(toca el micrófono para dictar)</span></label>
    <textarea id="nBody" placeholder="Escribe o dicta lo que explica el instructor…">${esc(n.body)}</textarea>
    <div class="row mt" style="gap:8px">
      <button class="btn sm" id="mic">&#127908; Dictar</button>
      <button class="btn sm" id="tpl">Usar plantilla</button>
    </div>

    <label class="f">Detalles clave (uno por línea)</label>
    <textarea id="nKp" style="min-height:90px" placeholder="Codo pegado al cuerpo
Cadera fuera antes de girar">${esc((n.keyPoints || []).join('\n'))}</textarea>

    <label class="f">Etiquetas (separadas por coma)</label>
    <input type="text" id="nTags" value="${esc((n.tags || []).join(', '))}" placeholder="gi, competencia, favorita">

    <label class="f">Estado</label>
    <select id="nSt">${Object.entries(STATUS).map(([k, s]) => `<option value="${k}" ${n.status === k ? 'selected' : ''}>${s.t}</option>`).join('')}</select>

    <button class="btn primary wide mt" id="okN">Guardar ficha</button>
  `, body => {
    const ta = $('#nBody', body);
    $('#mic', body).onclick = e => dictado(ta, e.currentTarget);
    $('#tpl', body).onclick = () => { if (!ta.value.trim()) ta.value = PLANTILLA; ta.focus(); };
    if (live) {
      $('#useA', body).onclick = () => $('#nA', body).value = fmt(live.currentTime);
      $('#useB', body).onclick = () => $('#nB', body).value = fmt(live.currentTime);
      $('#snap', body).onclick = () => {
        n.thumb = grabThumb(live);
        const im = $('#thPrev', body);
        if (im) im.src = n.thumb;
        else $('#nT', body).insertAdjacentHTML('beforebegin', `<img class="thumb big mb" id="thPrev" src="${n.thumb}" alt="">`);
        toast('Foto capturada');
      };
    }
    $('#okN', body).onclick = async () => {
      stopDictado();
      n.title = $('#nT', body).value.trim() || 'Sin título';
      n.start = parseTime($('#nA', body).value) ?? 0;
      n.end = parseTime($('#nB', body).value) ?? (n.start + 60);
      if (n.end <= n.start) n.end = n.start + 60;
      const pos = $('#nP', body).value;
      n.position = pos === '—' ? '' : pos;
      n.body = ta.value.trim();
      n.keyPoints = $('#nKp', body).value.split('\n').map(s => s.trim()).filter(Boolean);
      n.tags = $('#nTags', body).value.split(',').map(s => s.trim()).filter(Boolean);
      n.status = $('#nSt', body).value;
      await saveNote(n); closeSheet();
      nueva ? go('/note/' + n.id) : router();
      toast('Ficha guardada');
    };
  });
}

/* ======================================================================== */
/*  REPASO ESPACIADO                                                        */
/* ======================================================================== */
const dueNotes = () => S.notes
  .filter(n => (n.srs?.due ?? 0) <= Date.now() && n.status !== 'ok')
  .sort((a, b) => (a.srs?.due || 0) - (b.srs?.due || 0));

function calificar(n, g) {
  const s = n.srs || { interval: 0, reps: 0 };
  if (g === 0) {
    s.interval = 0; s.reps = 0; s.due = Date.now() + 10 * 60000;
    if (n.status === 'ok') n.status = 'drill';
  } else {
    s.interval = s.interval ? Math.min(180, Math.round(s.interval * (g === 2 ? 2.6 : 1.9))) : (g === 2 ? 4 : 1);
    s.due = Date.now() + s.interval * DAY;
    s.reps = (s.reps || 0) + 1;
    if (g === 2 && s.reps >= 3) n.status = 'ok';
    else if (n.status === 'nuevo') n.status = 'drill';
  }
  n.srs = s;
  return saveNote(n);
}

function viewRepaso(app) {
  $('#title').textContent = 'Repaso';
  const cola = dueNotes();
  if (!cola.length) {
    const prox = S.notes.filter(n => n.srs?.due > Date.now()).sort((a, b) => a.srs.due - b.srs.due)[0];
    app.innerHTML = `<div class="empty"><div class="big">&#9989;</div>
      <p>Nada por repasar ahora.</p>
      ${prox ? `<p class="sm">Siguiente: <b>${esc(prox.title)}</b><br>${new Date(prox.srs.due).toLocaleDateString('es-MX')}</p>` : ''}</div>`;
    return;
  }
  const n = cola[0];
  const part = S.parts.find(p => p.id === n.partId);
  const inst = S.inst.find(i => i.id === n.instId);

  app.innerHTML = `
    <div class="sm dim mb">${cola.length} en la cola de hoy</div>
    <div class="card">
      ${n.thumb ? `<img class="thumb big mb" src="${n.thumb}" alt="">` : ''}
      <strong>${esc(n.title)}</strong>
      <div class="sm dim">${esc(inst?.title || '')}${part ? ' · ' + esc(part.title) : ''} · <span class="mono">${fmt(n.start)}</span></div>
      <div class="row mt" style="gap:8px">
        <button class="btn grow" id="rShow">Mostrar notas</button>
        <button class="btn primary grow" id="rClip">&#9654; Clip</button>
      </div>
      <div id="rBody" class="mt" hidden>
        <hr class="sep">
        ${n.body ? `<div class="note-body sm">${esc(n.body)}</div>` : '<div class="sm dim">Sin notas escritas.</div>'}
        ${(n.keyPoints || []).length ? `<ul class="kp sm">${n.keyPoints.map(k => `<li>${esc(k)}</li>`).join('')}</ul>` : ''}
      </div>
    </div>
    <div class="row" style="gap:8px">
      <button class="btn grow" data-g="0">Otra vez</button>
      <button class="btn grow" data-g="1">Bien</button>
      <button class="btn grow" data-g="2">Fácil</button>
    </div>
    <a class="btn ghost wide mt sm" href="#/note/${n.id}">Abrir ficha completa</a>`;

  $('#rShow').onclick = e => { $('#rBody').hidden = false; e.target.remove(); };
  $('#rClip').onclick = () => playClip(n);
  $$('[data-g]').forEach(b => b.onclick = async () => { await calificar(n, +b.dataset.g); router(); });
}

/* ======================================================================== */
/*  BUSCAR                                                                  */
/* ======================================================================== */
function viewBuscar(app) {
  $('#title').textContent = 'Buscar';
  const tags = [...new Set(S.notes.flatMap(n => n.tags || []))].sort();
  app.innerHTML = `
    <input type="search" id="q" placeholder="Técnica, detalle, etiqueta…" autocomplete="off">
    <div class="chips mt" id="filtros">
      ${Object.entries(STATUS).map(([k, s]) => `<span class="chip" data-f="st:${k}">${s.t}</span>`).join('')}
      ${tags.map(t => `<span class="chip t" data-f="tag:${esc(t)}">${esc(t)}</span>`).join('')}
    </div>
    <div id="res" class="mt"></div>`;

  const activos = new Set();
  const pinta = () => {
    const q = $('#q').value.trim().toLowerCase();
    let r = S.notes.slice().sort(cmpNote);
    for (const f of activos) {
      const [k, v] = f.split(':');
      r = k === 'st' ? r.filter(n => n.status === v) : r.filter(n => (n.tags || []).includes(v));
    }
    if (q) r = r.filter(n => [n.title, n.body, n.position, (n.tags || []).join(' '), (n.keyPoints || []).join(' ')]
      .join(' ').toLowerCase().includes(q));
    $('#res').innerHTML = r.length
      ? `<div class="sm dim mb">${r.length} resultado${r.length === 1 ? '' : 's'}</div>` + r.slice(0, 120).map(noteCard).join('')
      : `<div class="empty sm">Nada encontrado.</div>`;
  };
  $('#q').oninput = pinta;
  $$('#filtros .chip').forEach(c => c.onclick = () => {
    const f = c.dataset.f;
    activos.has(f) ? activos.delete(f) : activos.add(f);
    c.classList.toggle('on', activos.has(f));
    pinta();
  });
  pinta();
}

/* ======================================================================== */
/*  EXPORTAR (Google Docs, Markdown, respaldo)                              */
/* ======================================================================== */
function download(name, mime, content) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 1500);
}
const slug = s => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 50) || 'notas';

function toMarkdown(instId) {
  const insts = instId ? S.inst.filter(i => i.id === instId) : S.inst;
  const L = [];
  for (const i of insts) {
    L.push(`# ${i.title}`);
    if (i.instructor) L.push(`**Instructor:** ${i.instructor}`);
    if (i.url) L.push(i.url);
    L.push('');
    for (const p of partsOf(i.id)) {
      const ns = notesOfPart(p.id);
      if (!ns.length) continue;
      L.push(`## ${p.title}`, '');
      for (const n of ns) {
        L.push(`### ${n.title}  \`${fmt(n.start)} – ${fmt(n.end)}\``);
        const meta = [n.position, (STATUS[n.status] || STATUS.nuevo).t, ...(n.tags || [])].filter(Boolean);
        if (meta.length) L.push(`*${meta.join(' · ')}*`);
        if (n.body) L.push('', n.body);
        if ((n.keyPoints || []).length) { L.push('', '**Detalles clave**'); n.keyPoints.forEach(k => L.push(`- ${k}`)); }
        L.push('');
      }
    }
  }
  return L.join('\n').trim() || '# Sin notas todavía';
}

function toHTML(instId, { images = true } = {}) {
  const insts = instId ? S.inst.filter(i => i.id === instId) : S.inst;
  const P = [];
  P.push(`<meta charset="utf-8"><div style="font-family:Georgia,serif;max-width:720px;line-height:1.5">`);
  for (const i of insts) {
    P.push(`<h1>${esc(i.title)}</h1>`);
    if (i.instructor) P.push(`<p><b>Instructor:</b> ${esc(i.instructor)}</p>`);
    if (i.url) P.push(`<p><a href="${esc(i.url)}">${esc(i.url)}</a></p>`);
    for (const p of partsOf(i.id)) {
      const ns = notesOfPart(p.id);
      if (!ns.length) continue;
      P.push(`<h2>${esc(p.title)}</h2>`);
      for (const n of ns) {
        P.push(`<h3>${esc(n.title)} <span style="color:#777;font-size:.8em">[${fmt(n.start)} – ${fmt(n.end)}]</span></h3>`);
        const meta = [n.position, (STATUS[n.status] || STATUS.nuevo).t, ...(n.tags || [])].filter(Boolean);
        if (meta.length) P.push(`<p style="color:#777;font-size:.85em"><i>${esc(meta.join(' · '))}</i></p>`);
        if (images && n.thumb) P.push(`<p><img src="${n.thumb}" style="max-width:320px;border-radius:6px"></p>`);
        if (n.body) P.push(`<p>${esc(n.body).replace(/\n/g, '<br>')}</p>`);
        if ((n.keyPoints || []).length)
          P.push(`<p><b>Detalles clave</b></p><ul>${n.keyPoints.map(k => `<li>${esc(k)}</li>`).join('')}</ul>`);
      }
    }
  }
  P.push('</div>');
  return P.join('\n');
}

function toJSON() {
  return JSON.stringify({
    app: 'tatami-bjj', version: 1, exportedAt: new Date().toISOString(),
    inst: S.inst,
    parts: S.parts.map(({ handle, ...p }) => p),   // los permisos de archivo no se exportan
    notes: S.notes
  }, null, 2);
}

async function copiarParaDocs(instId) {
  const html = toHTML(instId), texto = toMarkdown(instId);
  try {
    await navigator.clipboard.write([new ClipboardItem({
      'text/html': new Blob([html], { type: 'text/html' }),
      'text/plain': new Blob([texto], { type: 'text/plain' })
    })]);
    toast('Copiado. Pégalo en Google Docs.');
  } catch (e) {
    try { await navigator.clipboard.writeText(texto); toast('Copiado como texto'); }
    catch (e2) { toast('No pude copiar; usa “Descargar”'); }
  }
}

function exportSheet(instId) {
  const inst = instId ? S.inst.find(i => i.id === instId) : null;
  const nombre = slug(inst ? inst.title : 'mis-notas-jiujitsu');
  sheet('Exportar' + (inst ? ' · ' + inst.title : ''), `
    <div class="hint mb"><b>Para Google Docs:</b> toca “Copiar” y pega dentro de un documento nuevo,
    o descarga el archivo <b>.html</b>, súbelo a Google Drive y ábrelo con Documentos de Google
    (Drive lo convierte con títulos e imágenes incluidas).</div>
    <button class="btn primary wide" id="eCopy">&#128203; Copiar para Google Docs</button>
    <button class="btn wide mt" id="eHtml">Descargar .html (Drive / Docs)</button>
    <button class="btn wide mt" id="eMd">Descargar .md (Markdown)</button>
    <button class="btn wide mt" id="eJson">Respaldo .json (para restaurar)</button>
  `, body => {
    $('#eCopy', body).onclick = () => copiarParaDocs(instId);
    $('#eHtml', body).onclick = () => download(nombre + '.html', 'text/html', toHTML(instId));
    $('#eMd', body).onclick = () => download(nombre + '.md', 'text/markdown', toMarkdown(instId));
    $('#eJson', body).onclick = () => download(nombre + '-respaldo.json', 'application/json', toJSON());
  });
}

async function importarJSON(file) {
  const d = JSON.parse(await file.text());
  if (!d || !Array.isArray(d.inst)) throw new Error('formato');
  let n = 0;
  for (const i of d.inst) { await DB.put('inst', i); n++; }
  for (const p of (d.parts || [])) await DB.put('parts', p);
  for (const x of (d.notes || [])) await DB.put('notes', x);
  await loadAll();
  toast(`Restaurado: ${n} instruccionales, ${(d.notes || []).length} fichas`);
  go('/biblioteca');
}

/* ======================================================================== */
/*  AJUSTES                                                                 */
/* ======================================================================== */
let deferredInstall = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredInstall = e; });

function viewAjustes(app) {
  $('#title').textContent = 'Ajustes';
  const ok = S.notes.filter(n => n.status === 'ok').length;
  app.innerHTML = `
    <div class="card">
      <strong class="sm">Tu progreso</strong>
      <div class="row mt wrap" style="gap:14px">
        <div><div style="font-size:22px">${S.inst.length}</div><div class="xs dim">instruccionales</div></div>
        <div><div style="font-size:22px">${S.notes.length}</div><div class="xs dim">fichas</div></div>
        <div><div style="font-size:22px">${ok}</div><div class="xs dim">dominadas</div></div>
        <div><div style="font-size:22px">${dueNotes().length}</div><div class="xs dim">por repasar</div></div>
      </div>
    </div>

    <div class="card">
      <strong class="sm">Notas y respaldos</strong>
      <button class="btn wide mt" id="aExp">Exportar todo / Google Docs</button>
      <button class="btn wide mt" id="aImp">Restaurar desde respaldo .json</button>
      <div class="xs dim mt">Haz un respaldo de vez en cuando: si borras los datos del navegador, las fichas se pierden.</div>
    </div>

    <div class="card">
      <strong class="sm">Instalar en el teléfono</strong>
      <button class="btn wide mt" id="aInst">Agregar a la pantalla de inicio</button>
      <div class="xs dim mt">Si el botón no hace nada, usa el menú (⋮) de Chrome → “Instalar aplicación” o “Agregar a pantalla principal”.</div>
    </div>

    <div class="card">
      <strong class="sm">Privacidad</strong>
      <div class="sm dim mt">Tus videos nunca salen del teléfono: la app los abre desde tu almacenamiento y sólo guarda
      tiempos, notas y miniaturas. Todo funciona sin internet.</div>
    </div>

    <button class="btn ghost wide" id="aWipe" style="color:var(--acc)">Borrar todos los datos</button>
    <div class="center xs dim mt">Tatami · v1.0</div>`;

  $('#aExp').onclick = () => exportSheet(null);
  $('#aImp').onclick = () => {
    const inp = $('#jsonPicker'); inp.value = '';
    inp.onchange = async () => {
      const f = inp.files[0]; if (!f) return;
      try { await importarJSON(f); } catch (e) { toast('Ese archivo no es un respaldo válido'); }
    };
    inp.click();
  };
  $('#aInst').onclick = async () => {
    if (!deferredInstall) return toast('Usa el menú ⋮ de Chrome → Instalar aplicación');
    deferredInstall.prompt(); deferredInstall = null;
  };
  $('#aWipe').onclick = () => confirmar('Se borra todo: instruccionales, partes y fichas. ¿Seguro?', async () => {
    await Promise.all(['inst', 'parts', 'notes'].map(s => DB.clear(s)));
    await loadAll(); go('/biblioteca'); toast('Todo borrado');
  });
}

/* ======================================================================== */
/*  ARRANQUE                                                                */
/* ======================================================================== */
(async function init() {
  try { navigator.storage?.persist?.(); } catch (e) {}
  await loadAll();
  router();
  if ('serviceWorker' in navigator)
    navigator.serviceWorker.register('sw.js').catch(() => {});
})();
