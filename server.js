const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const url    = require('url');
const crypto = require('crypto');
const zlib   = require('zlib');

// ── Load .env config ──────────────────────────────────────────────────────────
function loadEnv() {
  const envFile = path.join(__dirname, '.env');
  if (!fs.existsSync(envFile)) return;
  fs.readFileSync(envFile, 'utf8').split('\n').forEach(line => {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  });
}
loadEnv();

const PORT          = parseInt(process.env.PORT)          || 3000;
const SESSION_HOURS = parseInt(process.env.SESSION_HOURS) || 8;
const RATE_MAX      = parseInt(process.env.RATE_MAX)      || 5;
const RATE_WINDOW   = parseInt(process.env.RATE_WINDOW)   || 10;

// [FIX #3] CORS whitelist via .env: ALLOWED_ORIGINS=http://domain1.com,http://domain2.com
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);



const DB_FILE   = path.join(__dirname, 'database', 'queue.db.json');
const BCK_DIR   = path.join(__dirname, 'database', 'backups');
const SES_FILE  = path.join(__dirname, 'database', 'sessions.json');
const LOG_DIR   = path.join(__dirname, 'database', 'logs');
const AUDIO_DIR = path.join(__dirname, 'public', 'audio');
const VIDEO_DIR = path.join(__dirname, 'public', 'video');
const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads');
const PUBLIC_DIR = path.join(__dirname, 'public');

// [FIX #5] Batas ukuran upload audio (10 MB)
const AUDIO_MAX_BYTES = 10 * 1024 * 1024;
const LOGO_MAX_BYTES = 2 * 1024 * 1024; // 2MB for logo
const VIDEO_MAX_BYTES = 100 * 1024 * 1024; // 100 MB untuk video

// ── Ensure dirs ───────────────────────────────────────────────────────────────
[path.join(__dirname, 'database'), BCK_DIR, AUDIO_DIR, VIDEO_DIR, LOG_DIR, UPLOAD_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ── [FIX #2] Password hashing: PBKDF2 menggantikan SHA-256 + salt statis ─────
function hashPw(pw) {
  const salt       = crypto.randomBytes(16).toString('hex');
  const iterations = 100000;
  const key        = crypto.pbkdf2Sync(pw, salt, iterations, 32, 'sha256').toString('hex');
  return `pbkdf2$${iterations}$${salt}$${key}`;
}

function verifyPw(pw, stored) {
  if (!stored.startsWith('pbkdf2$')) {
    // Dukung hash lama (SHA-256) untuk migrasi mulus
    const oldSalt = process.env.PW_SALT || 'antrian_salt_2024';
    const oldHash = crypto.createHash('sha256').update(pw + oldSalt).digest('hex');
    if (oldHash.length !== stored.length) return false;
    return crypto.timingSafeEqual(Buffer.from(oldHash), Buffer.from(stored));
  }
  const [, iter, salt, expected] = stored.split('$');
  const actual = crypto.pbkdf2Sync(pw, salt, parseInt(iter), 32, 'sha256').toString('hex');
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}

// ── DB ─────────────────────────────────────────────────────────────────────────
function loadDB() {
  if (!fs.existsSync(DB_FILE)) return initDB();
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch (e) { console.error('DB load error, reinitializing:', e.message); return initDB(); }
}

function saveDB(db) {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

function initDB() {
  // [FIX #1] Password TIDAK hardcoded — dibangkitkan acak atau dari .env
  const adminPw   = process.env.INIT_ADMIN_PW   || crypto.randomBytes(8).toString('hex');
  const petugasPw = process.env.INIT_PETUGAS_PW || crypto.randomBytes(8).toString('hex');

  console.log('\n╔════════════════════════════════════════════════════╗');
  console.log('║  INISIALISASI DATABASE — SIMPAN KREDENSIAL INI!   ║');
  console.log(`║  admin   password: ${adminPw.padEnd(30)} ║`);
  console.log(`║  petugas password: ${petugasPw.padEnd(30)} ║`);
  console.log('║  Ganti password segera setelah login pertama!     ║');
  console.log('╚════════════════════════════════════════════════════╝\n');

  const db = {
    services: [
      { id: 1, name: 'Administrasi', prefix: 'A', active: true, created_at: new Date().toISOString() },
      { id: 2, name: 'Pembayaran',   prefix: 'B', active: true, created_at: new Date().toISOString() },
      { id: 3, name: 'Konsultasi',   prefix: 'C', active: true, created_at: new Date().toISOString() },
    ],
    queues: [],
    counters: [
      { id: 1, name: 'Loket 1', current_queue: null, operator: 'Petugas 1' },
      { id: 2, name: 'Loket 2', current_queue: null, operator: 'Petugas 2' },
      { id: 3, name: 'Loket 3', current_queue: null, operator: 'Petugas 3' },
    ],
    settings: {
      institution_name:     'SISTEM ANTRIAN DIGITAL',
      institution_subtitle: 'Pelayanan Prima untuk Anda',
      running_text:         'Selamat datang. Mohon ambil nomor antrian dan tunggu giliran Anda dipanggil.',
      last_reset:           new Date().toDateString(),
      avg_service_minutes:  5,
      custom_audio:         null,
      custom_video:         null,
      custom_logo:          null,
      slide_duration:       5,
      slide_order:          [],
      auto_print:           false,
    },
    users: [
      { id: 1, username: 'admin',   password: hashPw(adminPw),   role: 'admin'   },
      { id: 2, username: 'petugas', password: hashPw(petugasPw), role: 'officer' },
    ],
    next_service_id: 4,
    next_user_id:    3,
  };
  saveDB(db);
  return db;
}

function migrateDB(db) {
  let changed = false;
  if (!db.users) {
    const pw = crypto.randomBytes(8).toString('hex');
    console.log(`[MIGRATE] Password admin acak: ${pw}`);
    db.users = [
      { id: 1, username: 'admin',   password: hashPw(pw),                role: 'admin'   },
      { id: 2, username: 'petugas', password: hashPw('ganti_segera_123'), role: 'officer' },
    ];
    changed = true;
  }
  if (!db.next_user_id)               { db.next_user_id = (db.users?.length || 2) + 1; changed = true; }
  if (!db.next_service_id)            { db.next_service_id = Math.max(...db.services.map(s => s.id), 0) + 1; changed = true; }
  if (db.settings.avg_service_minutes == null) { db.settings.avg_service_minutes = 5;  changed = true; }
  if (!('custom_audio' in db.settings))        { db.settings.custom_audio = null;       changed = true; }
  if (!('custom_video' in db.settings))        { db.settings.custom_video = null;       changed = true; }
  if (!('custom_logo' in db.settings))         { db.settings.custom_logo = null;        changed = true; }
  if (!('slide_duration' in db.settings))      { db.settings.slide_duration = 5;        changed = true; }
  if (!('slide_order' in db.settings))         { db.settings.slide_order = [];          changed = true; }
  if (!('auto_print' in db.settings))          { db.settings.auto_print = false;        changed = true; }
  if (!('break_mode' in db.settings))          { db.settings.break_mode = false;        changed = true; }
  if (!('break_message' in db.settings))       { db.settings.break_message = '';        changed = true; }
  if (!('break_schedule' in db.settings))      { db.settings.break_schedule = [];       changed = true; }
  if (!('voice_volume' in db.settings))        { db.settings.voice_volume = 0.9;        changed = true; }
  if (!('voice_rate' in db.settings))          { db.settings.voice_rate = 0.78;         changed = true; }
  if (!('voice_pitch' in db.settings))         { db.settings.voice_pitch = 1.02;        changed = true; }
  if (!('max_recall' in db.settings))          { db.settings.max_recall = 3;            changed = true; }
  if (changed) { saveDB(db); console.log('[MIGRATE] Database diperbarui'); }
  return db;
}

let db = migrateDB(loadDB());

// ── Sessions ──────────────────────────────────────────────────────────────────
function loadSessions() {
  if (!fs.existsSync(SES_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(SES_FILE, 'utf8')); } catch { return {}; }
}
function saveSessions(s) { fs.writeFileSync(SES_FILE, JSON.stringify(s)); }
let sessions = loadSessions();

function createSession(userId, role) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions[token] = { userId, role, expires: Date.now() + SESSION_HOURS * 3600 * 1000 };
  saveSessions(sessions);
  return token;
}

function getSession(req) {
  const cookie = req.headers.cookie || '';
  const match  = cookie.match(/session=([a-f0-9]{64})/);
  if (!match) return null;
  const s = sessions[match[1]];
  if (!s || s.expires < Date.now()) return null;
  return s;
}

setInterval(() => {
  const now = Date.now();
  Object.keys(sessions).forEach(k => { if (sessions[k].expires < now) delete sessions[k]; });
  saveSessions(sessions);
}, 3600000);

// ── Rate Limiter (login) ───────────────────────────────────────────────────────
const loginAttempts = new Map();

function checkRateLimit(ip) {
  const now = Date.now(), win = RATE_WINDOW * 60 * 1000;
  const entry = loginAttempts.get(ip);
  if (!entry || now - entry.firstAt > win) { loginAttempts.set(ip, { count: 0, firstAt: now }); return { blocked: false }; }
  if (entry.count >= RATE_MAX) return { blocked: true, remaining: Math.ceil((entry.firstAt + win - now) / 60000) };
  return { blocked: false };
}
function recordFailedLogin(ip) {
  const now = Date.now(), win = RATE_WINDOW * 60 * 1000;
  const entry = loginAttempts.get(ip);
  if (!entry || now - entry.firstAt > win) loginAttempts.set(ip, { count: 1, firstAt: now });
  else entry.count++;
}
function clearRateLimit(ip) { loginAttempts.delete(ip); }

// ── Rate Limiter (kiosk take queue) — maks 10 nomor per IP per menit ──────────
const kioskAttempts = new Map();
const KIOSK_MAX = 10, KIOSK_WIN = 60 * 1000; // 10 per 1 menit

function checkKioskLimit(ip) {
  const now = Date.now();
  const entry = kioskAttempts.get(ip);
  if (!entry || now - entry.firstAt > KIOSK_WIN) { kioskAttempts.set(ip, { count: 1, firstAt: now }); return false; }
  if (entry.count >= KIOSK_MAX) return true;
  entry.count++;
  return false;
}

setInterval(() => {
  const now = Date.now();
  kioskAttempts.forEach((v, k) => { if (now - v.firstAt > KIOSK_WIN) kioskAttempts.delete(k); });
}, 120000);



setInterval(() => {
  const now = Date.now();
  loginAttempts.forEach((v, k) => { if (now - v.firstAt > RATE_WINDOW * 60 * 1000) loginAttempts.delete(k); });
}, 1800000);

// ── [FIX #11] Activity Logger — rotasi per hari ───────────────────────────────
function logActivity(username, action, detail = '') {
  const ts   = new Date().toISOString();
  const date = ts.slice(0, 10);
  const line = `[${ts}] ${username} | ${action}${detail ? ' | ' + detail : ''}\n`;
  try {
    fs.appendFileSync(path.join(LOG_DIR, `activity-${date}.log`), line);
    const files = fs.readdirSync(LOG_DIR).filter(f => f.startsWith('activity-') && f.endsWith('.log')).sort();
    files.slice(0, Math.max(0, files.length - 30)).forEach(f => {
      try { fs.unlinkSync(path.join(LOG_DIR, f)); } catch {}
    });
  } catch {}
  console.log(`[LOG] ${username} | ${action}${detail ? ' | ' + detail : ''}`);
}

// ── Input Sanitizer ────────────────────────────────────────────────────────────
function sanitize(str, maxLen = 100) {
  if (typeof str !== 'string') return '';
  return str.replace(/[<>'"`;]/g, '').replace(/\0/g, '').trim().slice(0, maxLen);
}
function sanitizePrefix(str) {
  return (str || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 3);
}

// [FIX #9] ID unik berbasis crypto (hindari collision Date.now)
function generateId() {
  return Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
}

// [FIX #10] Validasi kekuatan password
function validatePasswordStrength(pw) {
  if (!pw || pw.length < 8)   return 'Password minimal 8 karakter';
  if (!/[A-Z]/.test(pw))      return 'Password harus mengandung minimal 1 huruf besar';
  if (!/[0-9]/.test(pw))      return 'Password harus mengandung minimal 1 angka';
  return null;
}

// ── Backup ────────────────────────────────────────────────────────────────────
function doBackup() {
  if (!fs.existsSync(DB_FILE)) return;
  const ts   = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dest = path.join(BCK_DIR, `queue-${ts}.json`);
  try {
    fs.copyFileSync(DB_FILE, dest);
    const files = fs.readdirSync(BCK_DIR).filter(f => f.endsWith('.json')).sort().reverse();
    files.slice(30).forEach(f => { try { fs.unlinkSync(path.join(BCK_DIR, f)); } catch {} });
    console.log(`[BACKUP] Saved: ${path.basename(dest)}`);
  } catch (e) { console.error('[BACKUP] Error:', e.message); }
}
setInterval(doBackup, 6 * 3600 * 1000);
setTimeout(doBackup, 5000);

// ── Daily reset ───────────────────────────────────────────────────────────────
function checkDailyReset() {
  const today = new Date().toDateString();
  if (db.settings.last_reset !== today) {
    doBackup();
    db.queues = [];
    db.counters.forEach(c => c.current_queue = null);
    db.settings.last_reset = today;
    saveDB(db);
    broadcast({ type: 'reset' });
    console.log('[RESET] Daily reset executed');
  }
}
setInterval(checkDailyReset, 60000);

// ── Jadwal Istirahat Otomatis ─────────────────────────────────────────────────
// break_schedule: [{ start: "12:00", end: "13:00", message: "...", enabled: true }, ...]
function checkBreakSchedule() {
  const schedules = db.settings.break_schedule || [];
  if (!schedules.length) return;

  const now  = new Date();
  const hhmm = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;

  // Cari jadwal yang aktif & sesuai waktu sekarang
  const shouldBreak = schedules.some(s => s.enabled && s.start && s.end && hhmm >= s.start && hhmm < s.end);
  const activeSchedule = schedules.find(s => s.enabled && s.start && s.end && hhmm >= s.start && hhmm < s.end);

  if (shouldBreak && !db.settings.break_mode) {
    // Aktifkan istirahat otomatis
    db.settings.break_mode    = true;
    db.settings.break_message = activeSchedule?.message || '';
    db.settings._break_auto   = true; // tandai otomatis agar tidak override manual
    saveDB(db);
    broadcast({ type: 'break_mode', active: true, message: db.settings.break_message, end: activeSchedule.end, auto: true });
    logActivity('SYSTEM', 'BREAK_ON', `Jadwal otomatis ${activeSchedule.start}–${activeSchedule.end}`);
    console.log(`[BREAK] Istirahat otomatis aktif: ${activeSchedule.start}–${activeSchedule.end}`);
  } else if (!shouldBreak && db.settings.break_mode && db.settings._break_auto) {
    // Nonaktifkan hanya jika diaktifkan oleh scheduler (bukan manual)
    db.settings.break_mode  = false;
    db.settings._break_auto = false;
    saveDB(db);
    broadcast({ type: 'break_mode', active: false, message: '', auto: true });
    logActivity('SYSTEM', 'BREAK_OFF', 'Jadwal otomatis selesai');
    console.log(`[BREAK] Istirahat otomatis selesai: ${hhmm}`);
  }
}
setInterval(checkBreakSchedule, 30000); // cek tiap 30 detik
setTimeout(checkBreakSchedule, 3000);   // cek 3 detik setelah start

// ── SSE ───────────────────────────────────────────────────────────────────────
const sseClients = new Set();
function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(r => { try { r.write(msg); } catch {} });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function getNextNumber(prefix, serviceId) {
  const today = new Date().toDateString();
  // Jika prefix kosong, nomor urut dihitung per service_id agar tidak campur antar layanan
  if (!prefix) return db.queues.filter(q => q.service_id === serviceId && new Date(q.created_at).toDateString() === today).length + 1;
  return db.queues.filter(q => q.prefix === prefix && new Date(q.created_at).toDateString() === today).length + 1;
}
function fmt(prefix, num) { return prefix + String(num); }

function todayQueues() {
  const today = new Date().toDateString();
  return db.queues.filter(q => new Date(q.created_at).toDateString() === today);
}

function getAvgMs() {
  const served = todayQueues().filter(q => q.status === 'served' && q.called_at && q.served_at);
  if (served.length < 3) return db.settings.avg_service_minutes * 60000;
  const avg = served.reduce((s, q) => s + (new Date(q.served_at) - new Date(q.called_at)), 0) / served.length;
  return Math.max(avg, 60000);
}

function estimateWait(serviceId) {
  const tq = todayQueues();
  let waiting = tq.filter(q => q.status === 'waiting');
  if (serviceId) waiting = waiting.filter(q => q.service_id === serviceId);
  const activeCounters = Math.max(db.counters.filter(c => c.current_queue).length, 1);
  const mins = Math.ceil((waiting.length / activeCounters) * (getAvgMs() / 60000));
  if (mins <= 0) return '< 1 menit';
  if (mins < 60) return `±${mins} menit`;
  return `±${Math.ceil(mins / 60)} jam`;
}

function getStats() {
  const tq = todayQueues();
  const byService = {};
  db.services.forEach(s => {
    byService[s.id] = {
      service:  s,
      total:    tq.filter(q => q.service_id === s.id).length,
      waiting:  tq.filter(q => q.service_id === s.id && q.status === 'waiting').length,
      served:   tq.filter(q => q.service_id === s.id && q.status === 'served').length,
      skipped:  tq.filter(q => q.service_id === s.id && q.status === 'skipped').length,
      estimate: estimateWait(s.id),
    };
  });
  return {
    total: tq.length,
    waiting: tq.filter(q => q.status === 'waiting').length,
    serving: tq.filter(q => q.status === 'serving').length,
    served:  tq.filter(q => q.status === 'served').length,
    skipped: tq.filter(q => q.status === 'skipped').length,
    byService,
    estimateWait: estimateWait(null),
  };
}

function generateCSV(queues) {
  const hdr  = 'Nomor Antrian,Layanan,Status,Loket,Waktu Ambil,Waktu Panggil,Waktu Selesai\n';
  const rows = queues.map(q => [
    q.queue_number, q.service_name, q.status,
    q.counter_id ? (db.counters.find(c => c.id === q.counter_id)?.name || '-') : '-',
    q.created_at ? new Date(q.created_at).toLocaleString('id-ID') : '-',
    q.called_at  ? new Date(q.called_at).toLocaleString('id-ID')  : '-',
    q.served_at  ? new Date(q.served_at).toLocaleString('id-ID')  : '-',
  ].map(v => `"${v}"`).join(',')).join('\n');
  return hdr + rows;
}

// ── MIME ──────────────────────────────────────────────────────────────────────
const MIME = {
  '.html':'text/html','.css':'text/css','.js':'application/javascript',
  '.json':'application/json','.png':'image/png','.ico':'image/x-icon',
  '.mp3':'audio/mpeg','.wav':'audio/wav','.ogg':'audio/ogg',
  '.mp4':'video/mp4','.webm':'video/webm','.mov':'video/quicktime',
  '.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.svg':'image/svg+xml','.webp':'image/webp',
};

// [FIX #3] CORS berdasarkan whitelist
function setCORSHeaders(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)) {
    if (ALLOWED_ORIGINS.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
}

// Security headers
function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // [FIX] Content-Security-Policy — cegah XSS dan injeksi resource eksternal
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://fonts.googleapis.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://fonts.gstatic.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; media-src 'self'; connect-src 'self' https://api.aladhan.com; frame-ancestors 'none';"
  );
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
}

function sendJSON(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}
function sendErr(res, msg, status = 400) { sendJSON(res, { error: msg }, status); }

function parseBody(req) {
  return new Promise((ok, fail) => {
    let b = '', size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > 1024 * 1024) return fail(new Error('Request body terlalu besar'));
      b += c;
    });
    req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch { fail(new Error('Invalid JSON')); } });
  });
}
function redir(res, loc) { res.writeHead(302, { Location: loc }); res.end(); }

function sendGzip(res, data, contentType) {
  const accept = res._req_accept_encoding || '';
  if (accept.includes('gzip') && data.length > 512) {
    zlib.gzip(data, (err, buf) => {
      if (err) { res.writeHead(200, { 'Content-Type': contentType }); return res.end(data); }
      res.writeHead(200, { 'Content-Type': contentType, 'Content-Encoding': 'gzip', 'Vary': 'Accept-Encoding' });
      res.end(buf);
    });
  } else {
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  }
}

function serveFile(res, fp) {
  fs.readFile(fp, (err, data) => {
    if (err) {
      const p404 = path.join(__dirname, 'views', '404.html');
      fs.readFile(p404, (e2, d2) => {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end(e2 ? '<h1>404 - Halaman Tidak Ditemukan</h1>' : d2);
      });
      return;
    }
    const ct = MIME[path.extname(fp)] || 'text/plain';
    sendGzip(res, data, ct);
  });
}

// Serve video dengan HTTP Range support (agar browser bisa seek)
function serveVideoStream(req, res, fp) {
  fs.stat(fp, (err, stat) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ct      = MIME[path.extname(fp)] || 'video/mp4';
    const total   = stat.size;
    const rangeHdr = req.headers['range'];

    if (!rangeHdr) {
      res.writeHead(200, { 'Content-Type': ct, 'Content-Length': total, 'Accept-Ranges': 'bytes' });
      fs.createReadStream(fp).pipe(res);
      return;
    }

    const [startStr, endStr] = rangeHdr.replace(/bytes=/, '').split('-');
    const start = parseInt(startStr, 10);
    const end   = endStr ? parseInt(endStr, 10) : Math.min(start + 1024 * 1024, total - 1);

    if (start >= total) {
      res.writeHead(416, { 'Content-Range': `bytes */${total}` });
      res.end();
      return;
    }

    const chunkSize = end - start + 1;
    res.writeHead(206, {
      'Content-Range':  `bytes ${start}-${end}/${total}`,
      'Accept-Ranges':  'bytes',
      'Content-Length': chunkSize,
      'Content-Type':   ct,
    });
    fs.createReadStream(fp, { start, end }).pipe(res);
  });
}

// Parse multipart/form-data
function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalSize = 0;
    req.on('data', c => {
      totalSize += c.length;
      if (totalSize > AUDIO_MAX_BYTES) return reject(new Error(`File melebihi batas ${AUDIO_MAX_BYTES / 1024 / 1024}MB`));
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const buf = Buffer.concat(chunks);
        const ct  = req.headers['content-type'] || '';
        const bm  = ct.match(/boundary=(.+)/);
        if (!bm) return reject(new Error('No boundary'));
        const boundary = Buffer.from('--' + bm[1].trim());
        const parts = [];
        let start = 0;
        while (true) {
          const idx = buf.indexOf(boundary, start);
          if (idx === -1) break;
          const end = buf.indexOf(boundary, idx + boundary.length);
          if (end === -1) break;
          const part      = buf.slice(idx + boundary.length + 2, end - 2);
          const headerEnd = part.indexOf('\r\n\r\n');
          if (headerEnd === -1) { start = idx + boundary.length; continue; }
          const headerStr = part.slice(0, headerEnd).toString();
          const body      = part.slice(headerEnd + 4);
          parts.push({ name: headerStr.match(/name="([^"]+)"/)?.[ 1], filename: headerStr.match(/filename="([^"]+)"/)?.[ 1], data: body });
          start = idx + boundary.length;
        }
        resolve(parts);
      } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// ── Server ────────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const parsed   = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const method   = req.method;

  setCORSHeaders(req, res);
  setSecurityHeaders(res);

  if (method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  res._req_accept_encoding = req.headers['accept-encoding'] || '';

  if (pathname === '/api/health') {
    return sendJSON(res, { status: 'ok', version: '4.1-secure', uptime: Math.floor(process.uptime()), timestamp: new Date().toISOString(), queues_today: todayQueues().length, connected_clients: sseClients.size });
  }

  if (pathname === '/events') {
    // [FIX SECURITY] SSE hanya untuk display (public) atau session valid
    // display boleh subscribe tanpa login (layar publik), tapi batasi info sensitif via broadcast
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (pathname.startsWith('/api/')) {
    try { await handleAPI(req, res, pathname, method, parsed.query); }
    catch (e) { sendErr(res, e.message, 500); }
    return;
  }

  if (pathname === '/login')   return serveFile(res, path.join(__dirname, 'views', 'login.html'));
  if (pathname === '/' || pathname === '/kiosk') return serveFile(res, path.join(__dirname, 'views', 'kiosk.html'));
  if (pathname === '/display') return serveFile(res, path.join(__dirname, 'views', 'display.html'));
  if (pathname === '/loket' || pathname.startsWith('/loket/')) {
    if (!getSession(req)) return redir(res, '/login?next=/loket');
    return serveFile(res, path.join(__dirname, 'views', 'loket.html'));
  }
  if (pathname === '/admin') {
    const s = getSession(req);
    if (!s || s.role !== 'admin') return redir(res, '/login?next=/admin');
    return serveFile(res, path.join(__dirname, 'views', 'admin.html'));
  }
  if (pathname.startsWith('/audio/')) return serveFile(res, path.join(AUDIO_DIR, path.basename(pathname)));
  if (pathname.startsWith('/video/')) {
    const fp = path.join(VIDEO_DIR, path.basename(pathname));
    const isVid = /\.(mp4|webm|mov)$/i.test(fp);
    return isVid ? serveVideoStream(req, res, fp) : serveFile(res, fp);
  }
  if (pathname.startsWith('/uploads/')) return serveFile(res, path.join(UPLOAD_DIR, path.basename(pathname)));
  if (pathname.startsWith('/js/')) return serveFile(res, path.join(__dirname, 'public', 'js', path.basename(pathname)));

  // [FIX] Path traversal — pastikan path yang di-resolve tetap di dalam PUBLIC_DIR
  const resolved = path.resolve(path.join(__dirname, 'public', pathname));
  if (!resolved.startsWith(PUBLIC_DIR + path.sep) && resolved !== PUBLIC_DIR) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('Forbidden');
  }
  serveFile(res, resolved);
});

// ── API ───────────────────────────────────────────────────────────────────────
async function handleAPI(req, res, pathname, method, query) {
  // [FIX] Hapus loadDB() per-request — gunakan variabel db in-memory.
  // db sudah diperbarui secara konsisten oleh saveDB() setelah setiap mutasi.

  // ── Public auth ────────────────────────────────────────────────────────────
  if (pathname === '/api/auth/login' && method === 'POST') {
    const ip   = req.socket.remoteAddress || 'unknown';
    const rate = checkRateLimit(ip);
    if (rate.blocked) return sendErr(res, `Terlalu banyak percobaan login. Coba lagi dalam ${rate.remaining} menit.`, 429);

    const body  = await parseBody(req);
    const uname = sanitize(body.username || '', 50);
    const user  = db.users.find(u => u.username === uname);

    if (!user || !verifyPw(body.password || '', user.password)) {
      recordFailedLogin(ip);
      const entry = loginAttempts.get(ip);
      logActivity(uname || 'unknown', 'LOGIN_FAILED', `IP: ${ip}`);
      return sendErr(res, `Username atau password salah. Sisa percobaan: ${Math.max(RATE_MAX - (entry?.count || 0), 0)}`, 401);
    }

    // Upgrade hash lama ke PBKDF2 otomatis
    if (!user.password.startsWith('pbkdf2$')) {
      user.password = hashPw(body.password);
      saveDB(db);
      console.log(`[SECURITY] Hash di-upgrade ke PBKDF2: ${user.username}`);
    }

    clearRateLimit(ip);
    const token = createSession(user.id, user.role);
    logActivity(user.username, 'LOGIN', `Role: ${user.role}, IP: ${ip}`);

    // [FIX #4] SameSite=Lax: aman dari CSRF eksternal, tapi izinkan redirect top-level
    // (SameSite=Strict memblokir cookie saat redirect dari /login ke /admin atau /loket)
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie': `session=${token}; HttpOnly; Path=/; Max-Age=${SESSION_HOURS * 3600}; SameSite=Lax`,
    });
    return res.end(JSON.stringify({ success: true, role: user.role, username: user.username }));
  }

  if (pathname === '/api/auth/logout' && method === 'POST') {
    const m = (req.headers.cookie || '').match(/session=([a-f0-9]{64})/);
    if (m) {
      const s = sessions[m[1]];
      if (s) { const u = db.users.find(u => u.id === s.userId); logActivity(u?.username || '?', 'LOGOUT'); }
      delete sessions[m[1]]; saveSessions(sessions);
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax' });
    return res.end(JSON.stringify({ success: true }));
  }

  if (pathname === '/api/auth/me' && method === 'GET') {
    const s = getSession(req);
    if (!s) return sendErr(res, 'Not authenticated', 401);
    const u = db.users.find(u => u.id === s.userId);
    return sendJSON(res, { username: u?.username, role: s.role });
  }

  // ── Public endpoints ───────────────────────────────────────────────────────
  if (pathname === '/api/services/active' && method === 'GET') {
    return sendJSON(res, db.services.filter(s => s.active).map(s => ({ ...s, estimate: estimateWait(s.id) })));
  }

  if (pathname === '/api/queue/take' && method === 'POST') {
    // [FIX SECURITY] Rate limit kiosk: maks 10 nomor per IP per menit
    const ip = req.socket.remoteAddress || 'unknown';
    if (checkKioskLimit(ip)) return sendErr(res, 'Terlalu banyak permintaan. Tunggu sebentar sebelum mengambil nomor lagi.', 429);

    const body = await parseBody(req);
    const svc  = db.services.find(s => s.id === parseInt(body.service_id) && s.active);
    if (!svc) return sendErr(res, 'Layanan tidak ditemukan atau tidak aktif');

    const entry = {
      id:           generateId(), // [FIX #9]
      queue_number: fmt(svc.prefix, getNextNumber(svc.prefix, svc.id)),
      prefix:       svc.prefix, service_id: svc.id, service_name: svc.name,
      status: 'waiting', counter_id: null,
      created_at: new Date().toISOString(), called_at: null, served_at: null,
    };
    db.queues.push(entry); saveDB(db);
    broadcast({ type: 'queue_updated', stats: getStats() });
    return sendJSON(res, { ...entry, estimate: estimateWait(svc.id) }, 201);
  }

  if (pathname === '/api/stats'        && method === 'GET') return sendJSON(res, getStats());
  if (pathname === '/api/settings'     && method === 'GET') return sendJSON(res, db.settings);
  if (pathname === '/api/counters'     && method === 'GET') return sendJSON(res, db.counters);

  if (pathname === '/api/recent-calls' && method === 'GET') {
    const r = todayQueues().filter(q => ['serving','served'].includes(q.status))
      .sort((a, b) => new Date(b.called_at) - new Date(a.called_at)).slice(0, 5);
    return sendJSON(res, r);
  }

  if (pathname === '/api/queue/waiting' && method === 'GET') {
    let w = todayQueues().filter(q => q.status === 'waiting');
    if (query.service_id) w = w.filter(q => q.service_id === parseInt(query.service_id));
    return sendJSON(res, w);
  }

  // ── Officer auth ───────────────────────────────────────────────────────────
  const ses = getSession(req);
  if (!ses) return sendErr(res, 'Login diperlukan', 401);

  // [FIX SECURITY] Dipindah ke zona auth — hanya petugas/admin yang bisa akses
  // Antrian yang dilewati (skipped) hari ini
  if (pathname === '/api/queue/skipped' && method === 'GET') {
    const s = todayQueues()
      .filter(q => q.status === 'skipped')
      .sort((a, b) => new Date(b.called_at || b.created_at) - new Date(a.called_at || a.created_at));
    return sendJSON(res, s);
  }

  // Kembalikan antrian skipped → waiting agar bisa dipanggil lagi
  const restoreMatch = pathname.match(/^\/api\/queue\/(.+)\/restore$/);
  if (restoreMatch && method === 'POST') {
    const qId = restoreMatch[1];
    const q   = db.queues.find(q => q.id === qId && q.status === 'skipped');
    if (!q) return sendErr(res, 'Antrian tidak ditemukan atau bukan status dilewati', 404);
    q.status     = 'waiting';
    q.counter_id = null;
    q.called_at  = null;
    saveDB(db);
    broadcast({ type: 'queue_updated', stats: getStats() });
    return sendJSON(res, { success: true, queue: q });
  }

  if (pathname === '/api/services' && method === 'GET') return sendJSON(res, db.services);

  const ctrMatch = pathname.match(/^\/api\/counters\/(\d+)\/(call-next|recall|skip|done)$/);
  if (ctrMatch && method === 'POST') {
    const id      = parseInt(ctrMatch[1]);
    const action  = ctrMatch[2];
    const counter = db.counters.find(c => c.id === id);
    if (!counter) return sendErr(res, 'Loket tidak ditemukan', 404);

    if (action === 'call-next') {
      const body = await parseBody(req);
      if (counter.current_queue) {
        const cur = db.queues.find(q => q.queue_number === counter.current_queue);
        if (cur) { cur.status = 'served'; cur.served_at = new Date().toISOString(); }
      }
      let waiting = todayQueues().filter(q => q.status === 'waiting');
      if (body.service_id) waiting = waiting.filter(q => q.service_id === parseInt(body.service_id));
      if (!waiting.length) {
        counter.current_queue = null; saveDB(db);
        broadcast({ type: 'counter_update', counter, action: 'no_queue' });
        return sendJSON(res, { message: 'No queue', counter });
      }
      const next = waiting[0];
      next.status = 'serving'; next.counter_id = id; next.called_at = new Date().toISOString(); next.called_count = 1;
      counter.current_queue = next.queue_number; saveDB(db);
      broadcast({ type: 'call', queue_number: next.queue_number, service_name: next.service_name, counter_id: id, counter_name: counter.name, counter, stats: getStats() });
      return sendJSON(res, { queue: next, counter });
    }
    if (action === 'recall') {
      if (!counter.current_queue) return sendErr(res, 'Tidak ada antrian aktif');
      const cur = db.queues.find(q => q.queue_number === counter.current_queue);
      if (cur) {
        cur.called_count = (cur.called_count || 1) + 1;
        const maxRecall = db.settings.max_recall || 3;
        if (cur.called_count > maxRecall) {
          // Auto-skip: sudah dipanggil melebihi batas
          cur.status = 'skipped'; cur.no_show = true;
          counter.current_queue = null; saveDB(db);
          broadcast({ type: 'counter_update', counter, action: 'auto_skip', queue_number: cur.queue_number, stats: getStats() });
          return sendJSON(res, { success: true, auto_skipped: true, queue_number: cur.queue_number });
        }
      }
      saveDB(db);
      broadcast({ type: 'call', queue_number: counter.current_queue, service_name: cur?.service_name || '', counter_id: id, counter_name: counter.name, counter, called_count: cur?.called_count || 1, max_recall: db.settings.max_recall || 3, stats: getStats() });
      return sendJSON(res, { success: true, called_count: cur?.called_count || 1 });
    }
    if (action === 'skip') {
      if (counter.current_queue) { const q = db.queues.find(q => q.queue_number === counter.current_queue); if (q) q.status = 'skipped'; }
      counter.current_queue = null; saveDB(db);
      broadcast({ type: 'counter_update', counter, stats: getStats() });
      return sendJSON(res, { success: true });
    }
    if (action === 'done') {
      if (counter.current_queue) { const q = db.queues.find(q => q.queue_number === counter.current_queue); if (q) { q.status = 'served'; q.served_at = new Date().toISOString(); } }
      counter.current_queue = null; saveDB(db);
      broadcast({ type: 'counter_update', counter, stats: getStats() });
      return sendJSON(res, { success: true });
    }
  }

  // ── Admin only ─────────────────────────────────────────────────────────────
  // Export data tersedia untuk admin (sudah punya session valid)
  if (pathname === '/api/queue/today'  && method === 'GET') return sendJSON(res, todayQueues());

  if (ses.role !== 'admin') return sendErr(res, 'Akses admin diperlukan', 403);

  if (pathname === '/api/services' && method === 'POST') {
    const body = await parseBody(req);
    const name = sanitize(body.name || '', 80), prefix = sanitizePrefix(body.prefix);
    if (!name) return sendErr(res, 'Nama layanan wajib diisi');
    // Prefix boleh kosong; jika diisi, cek duplikat hanya antar layanan yang sama-sama punya prefix
    if (prefix && db.services.find(s => s.prefix === prefix)) return sendErr(res, 'Kode prefix sudah digunakan layanan lain');
    const svc = { id: db.next_service_id++, name, prefix, active: true, created_at: new Date().toISOString() };
    db.services.push(svc); saveDB(db);
    logActivity(db.users.find(u => u.id === ses.userId)?.username || '?', 'ADD_SERVICE', `${prefix} - ${name}`);
    broadcast({ type: 'services_updated', services: db.services.filter(s => s.active) });
    return sendJSON(res, svc, 201);
  }

  if (pathname.match(/^\/api\/services\/\d+$/) && method === 'PUT') {
    const id = parseInt(pathname.split('/')[3]), svc = db.services.find(s => s.id === id);
    if (!svc) return sendErr(res, 'Not found', 404);
    const body = await parseBody(req);
    if (body.name   !== undefined) svc.name   = sanitize(body.name, 80);
    if (body.prefix !== undefined) svc.prefix = sanitizePrefix(body.prefix);
    if (body.active !== undefined) svc.active = body.active;
    saveDB(db);
    logActivity(db.users.find(u => u.id === ses.userId)?.username || '?', 'EDIT_SERVICE', `${svc.prefix} - ${svc.name}`);
    broadcast({ type: 'services_updated', services: db.services.filter(s => s.active) });
    return sendJSON(res, svc);
  }

  if (pathname.match(/^\/api\/services\/\d+$/) && method === 'DELETE') {
    const id = parseInt(pathname.split('/')[3]), idx = db.services.findIndex(s => s.id === id);
    if (idx === -1) return sendErr(res, 'Not found', 404);
    db.services.splice(idx, 1); saveDB(db);
    broadcast({ type: 'services_updated', services: db.services.filter(s => s.active) });
    return sendJSON(res, { success: true });
  }

  if (pathname === '/api/counters' && method === 'POST') {
    const body = await parseBody(req);
    // [FIX] ID collision: gunakan max id yang ada + 1, bukan length + 1
    // Jika loket dihapus lalu ditambah lagi, length bisa menghasilkan ID duplikat
    const nextId = Math.max(...db.counters.map(c => c.id), 0) + 1;
    const ctr = { id: nextId, name: sanitize(body.name || `Loket ${nextId}`, 50), current_queue: null, operator: sanitize(body.operator || 'Petugas', 50) };
    db.counters.push(ctr); saveDB(db); broadcast({ type: 'counters_updated' });
    return sendJSON(res, ctr, 201);
  }

  if (pathname.match(/^\/api\/counters\/\d+$/) && method === 'PUT') {
    const id = parseInt(pathname.split('/')[3]), ctr = db.counters.find(c => c.id === id);
    if (!ctr) return sendErr(res, 'Not found', 404);
    const body = await parseBody(req);
    if (body.name     !== undefined) ctr.name     = sanitize(body.name, 50);
    if (body.operator !== undefined) ctr.operator = sanitize(body.operator, 50);
    saveDB(db); broadcast({ type: 'counters_updated' });
    return sendJSON(res, ctr);
  }

  if (pathname.match(/^\/api\/counters\/\d+$/) && method === 'DELETE') {
    const id = parseInt(pathname.split('/')[3]), idx = db.counters.findIndex(c => c.id === id);
    if (idx === -1) return sendErr(res, 'Loket tidak ditemukan', 404);
    const deleted = db.counters[idx];
    db.counters.splice(idx, 1); saveDB(db);
    broadcast({ type: 'counters_updated' });
    logActivity(db.users.find(u => u.id === ses.userId)?.username || '?', 'DELETE_COUNTER', deleted.name);
    return sendJSON(res, { success: true });
  }

  if (pathname === '/api/settings' && method === 'PUT') {
    const body = await parseBody(req);
    ['institution_name','institution_subtitle','running_text','avg_service_minutes'].forEach(k => {
      if (body[k] !== undefined) db.settings[k] = typeof body[k] === 'string' ? sanitize(body[k], 200) : body[k];
    });
    if (body.slide_duration !== undefined) {
      const d = parseInt(body.slide_duration);
      if (!isNaN(d) && d >= 2 && d <= 60) db.settings.slide_duration = d;
    }
    if (Array.isArray(body.slide_order)) {
      db.settings.slide_order = body.slide_order.map(f => sanitize(String(f), 200)).slice(0, 100);
    }
    if (body.auto_print !== undefined) db.settings.auto_print = !!body.auto_print;
    // Voice settings
    if (body.voice_volume !== undefined) {
      const v = parseFloat(body.voice_volume);
      if (!isNaN(v) && v >= 0 && v <= 1) db.settings.voice_volume = v;
    }
    if (body.voice_rate !== undefined) {
      const v = parseFloat(body.voice_rate);
      if (!isNaN(v) && v >= 0.5 && v <= 1.5) db.settings.voice_rate = v;
    }
    if (body.voice_pitch !== undefined) {
      const v = parseFloat(body.voice_pitch);
      if (!isNaN(v) && v >= 0.8 && v <= 1.3) db.settings.voice_pitch = v;
    }
    if (body.max_recall !== undefined) {
      const v = parseInt(body.max_recall);
      if (!isNaN(v) && v >= 1 && v <= 10) db.settings.max_recall = v;
    }
    saveDB(db);
    broadcast({ type: 'settings_updated', settings: db.settings });
    return sendJSON(res, db.settings);
  }

  if (pathname === '/api/reset' && method === 'POST') {
    doBackup(); db.queues = []; db.counters.forEach(c => c.current_queue = null);
    db.settings.last_reset = new Date().toDateString(); saveDB(db);
    logActivity(db.users.find(u => u.id === ses.userId)?.username || '?', 'RESET_QUEUE', 'Manual reset');
    broadcast({ type: 'reset', stats: getStats() });
    return sendJSON(res, { success: true });
  }

  // ── Tes Suara ──────────────────────────────────────────────────────────────
  if (pathname === '/api/voice-test' && method === 'POST') {
    const body = await parseBody(req);
    const volume = parseFloat(body.volume) || db.settings.voice_volume || 0.9;
    const rate   = parseFloat(body.rate)   || db.settings.voice_rate   || 0.78;
    const pitch  = parseFloat(body.pitch)  || db.settings.voice_pitch  || 1.02;
    broadcast({ type: 'voice_test', volume, rate, pitch });
    return sendJSON(res, { success: true });
  }

  // ── Mode Istirahat ─────────────────────────────────────────────────────────
  if (pathname === '/api/break' && method === 'POST') {
    const body = await parseBody(req);
    const active  = !!body.active;
    const message = sanitize(body.message || '', 200);
    db.settings.break_mode    = active;
    db.settings.break_message = message;
    db.settings._break_auto   = false; // manual override → hapus flag auto
    saveDB(db);
    const username = db.users.find(u => u.id === ses.userId)?.username || '?';
    logActivity(username, active ? 'BREAK_ON' : 'BREAK_OFF', message || '-');
    broadcast({ type: 'break_mode', active, message });
    return sendJSON(res, { success: true, active, message });
  }

  // ── Jadwal Istirahat ───────────────────────────────────────────────────────
  if (pathname === '/api/break/schedule' && method === 'GET') {
    return sendJSON(res, db.settings.break_schedule || []);
  }

  if (pathname === '/api/break/schedule' && method === 'PUT') {
    const body = await parseBody(req);
    if (!Array.isArray(body)) return sendErr(res, 'Format tidak valid');
    // Validasi & sanitasi tiap jadwal
    db.settings.break_schedule = body.slice(0, 10).map((s, i) => ({
      id:      i,
      start:   (s.start   || '').replace(/[^0-9:]/g, '').slice(0, 5),
      end:     (s.end     || '').replace(/[^0-9:]/g, '').slice(0, 5),
      message: sanitize(s.message || '', 200),
      enabled: !!s.enabled,
    })).filter(s => /^\d{2}:\d{2}$/.test(s.start) && /^\d{2}:\d{2}$/.test(s.end));
    saveDB(db);
    logActivity(db.users.find(u => u.id === ses.userId)?.username || '?', 'SAVE_BREAK_SCHEDULE', `${db.settings.break_schedule.length} jadwal`);
    return sendJSON(res, db.settings.break_schedule);
  }

  if (pathname === '/api/export/csv' && method === 'GET') {
    const csv = generateCSV(todayQueues()), date = new Date().toISOString().slice(0, 10);
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="antrian-${date}.csv"` });
    return res.end('\uFEFF' + csv);
  }

  if (pathname === '/api/backup/now'  && method === 'POST') {
    doBackup();
    const files = fs.readdirSync(BCK_DIR).filter(f => f.endsWith('.json')).sort().reverse();
    return sendJSON(res, { success: true, backups: files.slice(0, 10) });
  }

  if (pathname === '/api/backup/list' && method === 'GET') {
    return sendJSON(res, fs.readdirSync(BCK_DIR).filter(f => f.endsWith('.json')).sort().reverse().slice(0, 20));
  }

  if (pathname === '/api/users' && method === 'GET') {
    return sendJSON(res, db.users.map(u => ({ id: u.id, username: u.username, role: u.role })));
  }

  if (pathname === '/api/users' && method === 'POST') {
    const body = await parseBody(req);
    const username = sanitize(body.username || '', 50);
    if (!username || !body.password) return sendErr(res, 'Username dan password wajib diisi');
    const pwErr = validatePasswordStrength(body.password); // [FIX #10]
    if (pwErr) return sendErr(res, pwErr);
    if (db.users.find(u => u.username === username)) return sendErr(res, 'Username sudah digunakan');
    const u = { id: db.next_user_id++, username, password: hashPw(body.password), role: body.role === 'admin' ? 'admin' : 'officer' };
    db.users.push(u); saveDB(db);
    logActivity(db.users.find(u => u.id === ses.userId)?.username || '?', 'ADD_USER', `${u.username} (${u.role})`);
    return sendJSON(res, { id: u.id, username: u.username, role: u.role }, 201);
  }

  if (pathname.match(/^\/api\/users\/\d+$/) && method === 'DELETE') {
    const id = parseInt(pathname.split('/')[3]);
    if (id === 1) return sendErr(res, 'Admin utama tidak bisa dihapus');
    const idx = db.users.findIndex(u => u.id === id);
    if (idx === -1) return sendErr(res, 'Not found', 404);
    const deleted = db.users[idx]; db.users.splice(idx, 1); saveDB(db);
    logActivity(db.users.find(u => u.id === ses.userId)?.username || '?', 'DELETE_USER', deleted.username);
    return sendJSON(res, { success: true });
  }

  if (pathname.match(/^\/api\/users\/\d+\/password$/) && method === 'PUT') {
    const id = parseInt(pathname.split('/')[3]), u = db.users.find(u => u.id === id);
    if (!u) return sendErr(res, 'Not found', 404);
    const body = await parseBody(req);
    if (!body.password) return sendErr(res, 'Password baru wajib diisi');
    const pwErr = validatePasswordStrength(body.password); // [FIX #10]
    if (pwErr) return sendErr(res, pwErr);
    u.password = hashPw(body.password); saveDB(db);
    logActivity(db.users.find(u => u.id === ses.userId)?.username || '?', 'CHANGE_PASSWORD', `Target: ${u.username}`);
    return sendJSON(res, { success: true });
  }

  // Audio
  if (pathname === '/api/audio/list' && method === 'GET') {
    return sendJSON(res, { files: fs.readdirSync(AUDIO_DIR).filter(f => /\.(mp3|wav|ogg)$/i.test(f)), active: db.settings.custom_audio || null });
  }

  if (pathname === '/api/audio/upload' && method === 'POST') {
    try {
      const parts = await parseMultipart(req);
      const file  = parts.find(p => p.filename);
      if (!file) return sendErr(res, 'Tidak ada file yang dikirim');
      const ext = path.extname(file.filename).toLowerCase();
      if (!['.mp3','.wav','.ogg'].includes(ext)) return sendErr(res, 'Format tidak didukung. Gunakan MP3, WAV, atau OGG');
      if (file.data.length > AUDIO_MAX_BYTES) return sendErr(res, `File terlalu besar. Maksimal ${AUDIO_MAX_BYTES/1024/1024}MB`); // [FIX #5]
      const safe = file.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
      fs.writeFileSync(path.join(AUDIO_DIR, safe), file.data);
      logActivity(db.users.find(u => u.id === ses.userId)?.username || '?', 'UPLOAD_AUDIO', safe);
      return sendJSON(res, { success: true, filename: safe });
    } catch (e) { return sendErr(res, 'Upload gagal: ' + e.message); }
  }

  if (pathname === '/api/audio/set-active' && method === 'POST') {
    const body = await parseBody(req);
    db.settings.custom_audio = body.filename || null; saveDB(db);
    broadcast({ type: 'settings_updated', settings: db.settings });
    return sendJSON(res, { success: true });
  }

  if (pathname.startsWith('/api/audio/delete/') && method === 'DELETE') {
    const fname = path.basename(pathname.replace('/api/audio/delete/', ''));
    const fp = path.join(AUDIO_DIR, fname);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
    if (db.settings.custom_audio === fname) { db.settings.custom_audio = null; saveDB(db); }
    return sendJSON(res, { success: true });
  }

  // ── Video endpoints ────────────────────────────────────────────────────────
  if (pathname === '/api/video/list' && method === 'GET') {
    return sendJSON(res, {
      files: fs.readdirSync(VIDEO_DIR).filter(f => /\.(mp4|webm|mov|jpg|jpeg|png|gif|webp|svg)$/i.test(f)),
      active: db.settings.custom_video || null
    });
  }

  if (pathname === '/api/video/upload' && method === 'POST') {
    // [FIX] Timeout diperpanjang hanya untuk endpoint ini (5 menit), bukan seluruh server
    req.setTimeout(5 * 60 * 1000);
    try {
      // Buffer seluruh request — sama seperti audio, tapi limit lebih besar
      const chunks = [];
      let totalSize = 0;
      await new Promise((resolve, reject) => {
        req.on('data', c => {
          totalSize += c.length;
          if (totalSize > VIDEO_MAX_BYTES) {
            req.destroy();
            return reject(new Error(`File melebihi batas ${VIDEO_MAX_BYTES/1024/1024}MB`));
          }
          chunks.push(c);
        });
        req.on('end', resolve);
        req.on('error', reject);
      });

      const buf = Buffer.concat(chunks);
      const ct  = req.headers['content-type'] || '';
      // Parse boundary — handle tanda kutip dan spasi
      const bm  = ct.match(/boundary=(?:"([^"]+)"|([^\s;]+))/);
      if (!bm) return sendErr(res, 'Format upload tidak valid');
      const boundary = Buffer.from('--' + (bm[1] || bm[2]).trim());

      // Cari part dengan filename (file binary)
      let file = null;
      let pos  = 0;
      while (pos < buf.length) {
        const bStart = buf.indexOf(boundary, pos);
        if (bStart === -1) break;
        // Lewati boundary + \r\n
        const partStart = bStart + boundary.length;
        if (partStart >= buf.length) break;
        // Cari \r\n\r\n — akhir header part
        const headerEnd = buf.indexOf(Buffer.from('\r\n\r\n'), partStart);
        if (headerEnd === -1) break;
        const headerStr = buf.slice(partStart, headerEnd).toString();
        const fnMatch   = headerStr.match(/filename="([^"]+)"/i);
        if (fnMatch) {
          // Data file dimulai setelah \r\n\r\n
          const dataStart = headerEnd + 4;
          // Data berakhir sebelum boundary berikutnya (dengan \r\n sebelumnya)
          const nextBoundary = buf.indexOf(boundary, dataStart);
          const dataEnd = nextBoundary !== -1 ? nextBoundary - 2 : buf.length; // -2 untuk strip \r\n
          file = { filename: fnMatch[1], data: buf.slice(dataStart, dataEnd) };
          break;
        }
        pos = partStart + 1;
      }

      if (!file) return sendErr(res, 'Tidak ada file yang dikirim');
      const ext = path.extname(file.filename).toLowerCase();
      const allowed = ['.mp4', '.webm', '.mov', '.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg'];
      if (!allowed.includes(ext))
        return sendErr(res, 'Format tidak didukung. Gunakan MP4/WEBM/MOV atau Gambar (JPG/PNG/GIF/WEBP)');

      const safe = file.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
      fs.writeFileSync(path.join(VIDEO_DIR, safe), file.data);
      logActivity(db.users.find(u => u.id === ses.userId)?.username || '?', 'UPLOAD_VIDEO', safe);
      return sendJSON(res, { success: true, filename: safe });

    } catch (e) {
      return sendErr(res, 'Upload gagal: ' + e.message);
    }
  }

  if (pathname === '/api/video/set-active' && method === 'POST') {
    const body = await parseBody(req);
    db.settings.custom_video = body.filename || null; saveDB(db);
    broadcast({ type: 'settings_updated', settings: db.settings });
    return sendJSON(res, { success: true });
  }

  if (pathname.startsWith('/api/video/delete/') && method === 'DELETE') {
    const fname = path.basename(pathname.replace('/api/video/delete/', ''));
    const fp = path.join(VIDEO_DIR, fname);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
    if (db.settings.custom_video === fname) { db.settings.custom_video = null; saveDB(db); }
    return sendJSON(res, { success: true });
  }

  // ── Logo Upload ────────────────────────────────────────────────────────────
  if (pathname === '/api/logo/upload' && method === 'POST') {
    try {
      const parts = await parseMultipart(req);
      const file  = parts.find(p => p.filename);
      if (!file) return sendErr(res, 'Tidak ada file logo yang dikirim');
      
      const ext = path.extname(file.filename).toLowerCase();
      const allowed = ['.jpg', '.jpeg', '.png', '.svg', '.webp'];
      if (!allowed.includes(ext)) return sendErr(res, 'Format tidak didukung. Gunakan JPG, PNG, SVG, atau WEBP');
      
      if (file.data.length > LOGO_MAX_BYTES) return sendErr(res, `File logo terlalu besar. Maksimal ${LOGO_MAX_BYTES/1024/1024}MB`);

      const safe = 'logo_' + Date.now() + ext;
      fs.writeFileSync(path.join(UPLOAD_DIR, safe), file.data);
      
      // Hapus logo lama jika ada
      if (db.settings.custom_logo) {
        try { fs.unlinkSync(path.join(UPLOAD_DIR, db.settings.custom_logo)); } catch {}
      }
      
      db.settings.custom_logo = safe;
      saveDB(db);
      logActivity(db.users.find(u => u.id === ses.userId)?.username || '?', 'UPLOAD_LOGO', safe);
      broadcast({ type: 'settings_updated', settings: db.settings });
      return sendJSON(res, { success: true, filename: safe });
    } catch (e) { return sendErr(res, 'Upload logo gagal: ' + e.message); }
  }

  if (pathname === '/api/logo/reset' && method === 'POST') {
    if (db.settings.custom_logo) {
      try { fs.unlinkSync(path.join(UPLOAD_DIR, db.settings.custom_logo)); } catch {}
    }
    db.settings.custom_logo = null;
    saveDB(db);
    broadcast({ type: 'settings_updated', settings: db.settings });
    return sendJSON(res, { success: true });
  }

  // Activity log — [FIX #11] baca dari file rotasi harian
  if (pathname === '/api/activity-log' && method === 'GET') {
    const today     = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    let lines = [];
    [today, yesterday].forEach(d => {
      const f = path.join(LOG_DIR, `activity-${d}.log`);
      if (fs.existsSync(f)) lines = lines.concat(fs.readFileSync(f, 'utf8').split('\n').filter(Boolean));
    });
    return sendJSON(res, lines.reverse().slice(0, 200));
  }

  if (pathname === '/api/stats/hourly' && method === 'GET') {
    const tq = todayQueues();
    return sendJSON(res, Array.from({ length: 24 }, (_, h) => ({
      hour: h, label: `${String(h).padStart(2,'0')}:00`,
      total:  tq.filter(q => new Date(q.created_at).getHours() === h).length,
      served: tq.filter(q => q.status === 'served' && new Date(q.created_at).getHours() === h).length,
    })));
  }

  sendErr(res, 'Not found', 404);
}

// [FIX] Jangan nonaktifkan timeout global — rentan DoS (slow loris attack).
// Timeout per-request untuk upload video ditangani via req.setTimeout() di handler-nya.
server.timeout        = 30000;   // 30 detik untuk request biasa
server.keepAliveTimeout = 65000;
server.headersTimeout   = 70000; // harus > keepAliveTimeout
server.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║  SISTEM ANTRIAN DIGITAL v4.6 (SECURE)   ║`);
  console.log(`║  Server berjalan di port ${PORT}              ║`);
  console.log(`╠══════════════════════════════════════════╣`);
  console.log(`║  Kiosk   → http://localhost:${PORT}/          ║`);
  console.log(`║  Loket   → http://localhost:${PORT}/loket     ║`);
  console.log(`║  Display → http://localhost:${PORT}/display   ║`);
  console.log(`║  Admin   → http://localhost:${PORT}/admin     ║`);
  console.log(`╚══════════════════════════════════════════╝\n`);
});
