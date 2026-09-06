const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = __dirname;
const databasePath = process.env.FITMIND_DB_PATH ? path.resolve(process.env.FITMIND_DB_PATH) : path.join(root, 'fitmind-db.json');
const sessions = new Map();
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const publicFiles = new Set(['index.html', 'app-fixed.js', 'recovery-engine.js', 'style.css', 'style-refinements.css']);
const coachDailyLimit = Math.max(1, Math.min(20, Number(process.env.COACH_DAILY_LIMIT) || 3));
const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'"
};
function loadLocalSecrets() {
  try {
    const allowed = new Set(['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_MODEL']);
    for (const rawLine of fs.readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const divider = line.indexOf('=');
      if (divider < 1) continue;
      const key = line.slice(0, divider).trim();
      let value = line.slice(divider + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      if (allowed.has(key) && !process.env[key]) process.env[key] = value;
    }
  } catch { /* .env is optional */ }
}
loadLocalSecrets();
const emptyData = name => ({ profile: { name, weight: 0, goal: 'Моя ціль' }, workouts: [], exercises: [], favorites: [], coachHistory: [] });
const textValue = (value, limit) => String(value ?? '').trim().slice(0, limit);
const numberValue = (value, min, max, fallback = min) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
};
function cleanExercise(exercise) {
  if (!exercise || typeof exercise !== 'object') return null;
  const name = textValue(exercise.name, 100);
  if (!name) return null;
  const muscles = Array.isArray(exercise.muscles) ? [...new Set(exercise.muscles.map(muscle => textValue(muscle, 40)).filter(Boolean))].slice(0, 6) : [];
  const sets = Array.isArray(exercise.sets) ? exercise.sets.slice(0, 30).map(set => ({
    weight: numberValue(set?.weight, 0, 2000, 0),
    reps: numberValue(set?.reps, 1, 1000, 1)
  })) : [];
  return { name, muscles, category: textValue(exercise.category, 50), sets };
}
function cleanUserData(payload, name) {
  if (!payload || typeof payload !== 'object' || !payload.profile || typeof payload.profile !== 'object' || !Array.isArray(payload.workouts)) return null;
  const profile = {
    name,
    weight: numberValue(payload.profile.weight, 0, 500, 0),
    goal: textValue(payload.profile.goal, 60) || 'Моя ціль'
  };
  const workouts = payload.workouts.slice(0, 1000).map(workout => {
    if (!workout || typeof workout !== 'object') return null;
    const completedAt = new Date(workout.completedAt);
    return {
      id: textValue(workout.id, 100) || crypto.randomUUID(),
      name: textValue(workout.name, 100) || 'Тренування',
      duration: numberValue(workout.duration, 1, 720, 60),
      completedAt: Number.isNaN(completedAt.getTime()) ? new Date().toISOString() : completedAt.toISOString(),
      exercises: Array.isArray(workout.exercises) ? workout.exercises.slice(0, 40).map(cleanExercise).filter(Boolean) : []
    };
  }).filter(Boolean);
  const exercises = Array.isArray(payload.exercises) ? payload.exercises.slice(0, 500).map(cleanExercise).filter(Boolean).map(exercise => ({ name: exercise.name, muscles: exercise.muscles, category: exercise.category })) : [];
  const favorites = Array.isArray(payload.favorites) ? [...new Set(payload.favorites.map(name => textValue(name, 100)).filter(Boolean))].slice(0, 100) : [];
  const coachHistory = Array.isArray(payload.coachHistory) ? payload.coachHistory.slice(-30).map(item => ({ role: item?.role === 'model' ? 'model' : 'user', text: textValue(item?.text, 2400) })).filter(item => item.text) : [];
  return { profile, workouts, exercises, favorites, coachHistory };
}

function normalizedUsername(value) { return textValue(value, 24).toLocaleLowerCase('uk-UA'); }
function isUsername(value) { return /^[\p{L}\p{N}_]{3,24}$/u.test(value); }
function dayKey() { return new Intl.DateTimeFormat('en-CA', { timeZone: process.env.APP_TIME_ZONE || 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
function coachQuota(user) { const usage = user?.coachUsage; const count = usage?.date === dayKey() ? Math.max(0, Number(usage.count) || 0) : 0; return { limit: coachDailyLimit, remaining: Math.max(0, coachDailyLimit - count) }; }
function consumeCoachRequest(userId) { const db = database(); const stored = db.users.find(item => item.id === userId); if (!stored) return null; const today = dayKey(), previous = stored.coachUsage?.date === today ? Math.max(0, Number(stored.coachUsage.count) || 0) : 0; if (previous >= coachDailyLimit) return { ...coachQuota(stored), exhausted: true }; stored.coachUsage = { date: today, count: previous + 1 }; saveDatabase(db); return { limit: coachDailyLimit, remaining: Math.max(0, coachDailyLimit - stored.coachUsage.count), exhausted: false } }

function database() {
  try { return JSON.parse(fs.readFileSync(databasePath, 'utf8')); }
  catch { return { users: [] }; }
}
function saveDatabase(db) { fs.writeFileSync(databasePath, JSON.stringify(db, null, 2)); }
function hash(password, salt) { return crypto.pbkdf2Sync(password, salt, 150000, 32, 'sha256').toString('hex'); }
const recoveryMuscles = {
  chest:{label:'Груди',hours:60}, back:{label:'Спина',hours:54}, traps:{label:'Трапеції',hours:46}, frontDelts:{label:'Передня дельта',hours:48}, sideDelts:{label:'Середня дельта',hours:44}, rearDelts:{label:'Задня дельта',hours:44}, biceps:{label:'Біцепс',hours:42}, triceps:{label:'Трицепс',hours:42}, forearms:{label:'Передпліччя',hours:36}, quads:{label:'Квадрицепси',hours:66}, hamstrings:{label:'Біцепс стегна',hours:60}, glutes:{label:'Сідниці',hours:60}, calves:{label:'Литки',hours:36}, core:{label:'Прес',hours:32}, lowerBack:{label:'Поперек',hours:48}, fullBody:{label:'Все тіло',hours:40}
};
function recoveryForCoach(workouts) {
  const now = Date.now();
  const muscles = Object.fromEntries(Object.entries(recoveryMuscles).map(([key, profile]) => [key, { key, ...profile, score: 100, last: null }]));
  for (const workout of workouts || []) {
    const hoursAgo = Math.max(0, (now - new Date(workout.completedAt || 0).getTime()) / 36e5);
    if (hoursAgo > 336) continue;
    for (const exercise of workout.exercises || []) {
      const volume = (exercise.sets || []).reduce((sum, set) => sum + Number(set.weight || 0) * Number(set.reps || 0), 0);
      const fatigue = Math.min(62, 6 + (exercise.sets || []).length * 8 + Math.min(16, Math.sqrt(Math.max(0, volume)) * .28));
      for (const key of exercise.muscles || []) {
        const muscle = muscles[key];
        if (!muscle) continue;
        muscle.score = Math.max(0, muscle.score - fatigue * Math.max(0, 1 - hoursAgo / muscle.hours));
        if (!muscle.last || new Date(workout.completedAt) > new Date(muscle.last)) muscle.last = workout.completedAt;
      }
    }
  }
  const list = Object.values(muscles).map(muscle => ({ name: muscle.label, score: Math.round(muscle.score), last: muscle.last, hours: muscle.hours })).sort((a, b) => a.score - b.score);
  const average = list.reduce((sum, muscle) => sum + muscle.score, 0) / list.length;
  const active = list.filter(muscle => muscle.last && now - new Date(muscle.last).getTime() < muscle.hours * 36e5);
  const activeAverage = active.length ? active.reduce((sum, muscle) => sum + muscle.score, 0) / active.length : 100;
  return { readiness: Math.round(average * .45 + activeAverage * .55), muscles: list, ready: list.filter(muscle => muscle.score >= 70).slice(-5), tired: list.filter(muscle => muscle.score < 70) };
}
function isCompleteCoachAnswer(value) {
  const text = String(value || '').trim();
  // A short partial sentence is worse than a complete local recommendation.
  // The prompt below requires a final sentence, which makes this check reliable.
  return text.length >= 45 && /[.!?…][”"')\]]*$/.test(text);
}
function json(res, status, body, headers = {}) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...securityHeaders, ...headers }); res.end(JSON.stringify(body)); }
function readBody(req) { return new Promise(resolve => { let data = ''; let tooLarge = false; req.on('data', c => { if (tooLarge) return; data += c; if (data.length > 1024 * 1024) { tooLarge = true; data = ''; } }); req.on('end', () => { if (tooLarge) return resolve(null); try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } }); }); }
function cookie(req) { try { return Object.fromEntries((req.headers.cookie || '').split(';').map(x => x.trim().split('=').map(decodeURIComponent)).filter(x => x.length === 2)); } catch { return {}; } }
function currentUser(req) { const id = sessions.get(cookie(req).fm_session); return id ? database().users.find(user => user.id === id) : null; }
function publicUser(user) { return { id: user.id, name: user.name, username: user.username || '', email: user.email }; }
function sessionHeaders(user) { const token = crypto.randomBytes(32).toString('hex'); const secure = process.env.SECURE_COOKIES === 'true' || process.env.SSL_KEY_PATH; sessions.set(token, user.id); return { 'Set-Cookie': `fm_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${secure ? '; Secure' : ''}` }; }
function serveFile(req, res) {
  if (!['GET', 'HEAD'].includes(req.method)) return res.writeHead(405, { ...securityHeaders, Allow: 'GET, HEAD' }).end();
  let requestPath;
  try { requestPath = req.url === '/' ? '/index.html' : decodeURIComponent(req.url.split('?')[0]); } catch { return res.writeHead(400).end(); }
  const filename = requestPath.startsWith('/') ? requestPath.slice(1) : requestPath;
  if (!publicFiles.has(filename)) return res.writeHead(404, securityHeaders).end('Not found');
  const file = path.join(root, filename);
  fs.readFile(file, (error, data) => { if (error) return res.writeHead(404, securityHeaders).end('Not found'); res.writeHead(200, { 'Content-Type': `${types[path.extname(file)]}; charset=utf-8`, 'Cache-Control': 'no-store, max-age=0', ...securityHeaders }); res.end(req.method === 'HEAD' ? undefined : data); });
}

const handler = async (req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (!url.startsWith('/api/')) return serveFile(req, res);
  const method = req.method;
  if (method === 'POST' && url === '/api/auth/register') {
    const { name = '', username = '', email = '', password = '' } = (await readBody(req)) || {};
    const cleanEmail = email.trim().toLowerCase(), cleanName = name.trim(), cleanUsername = normalizedUsername(username);
    if (!cleanName || cleanName.length > 60 || !isUsername(cleanUsername) || cleanEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(cleanEmail) || password.length < 8 || password.length > 200) return json(res, 400, { error: 'Вкажи ім’я, нікнейм (3–24 символи), коректний email і пароль від 8 символів.' });
    const db = database();
    if (db.users.some(user => user.email === cleanEmail)) return json(res, 409, { error: 'Акаунт із цим email уже існує.' });
    if (db.users.some(user => normalizedUsername(user.username) === cleanUsername)) return json(res, 409, { error: 'Цей нікнейм уже зайнятий.' });
    const salt = crypto.randomBytes(16).toString('hex');
    const user = { id: crypto.randomUUID(), name: cleanName, username: cleanUsername, email: cleanEmail, salt, passwordHash: hash(password, salt), data: emptyData(cleanName) };
    db.users.push(user); saveDatabase(db); return json(res, 201, { user: publicUser(user), data: user.data, coach: coachQuota(user) }, sessionHeaders(user));
  }
  if (method === 'POST' && url === '/api/auth/login') {
    const { email = '', password = '' } = (await readBody(req)) || {}; const user = database().users.find(item => item.email === email.trim().toLowerCase());
    const storedHash = user?.passwordHash && user?.salt ? Buffer.from(user.passwordHash, 'hex') : null;
    const suppliedHash = user?.salt ? Buffer.from(hash(password, user.salt), 'hex') : null;
    if (!storedHash || !suppliedHash || storedHash.length !== suppliedHash.length || !crypto.timingSafeEqual(storedHash, suppliedHash)) return json(res, 401, { error: 'Невірний email або пароль.' });
    return json(res, 200, { user: publicUser(user), data: user.data || emptyData(user.name), coach: coachQuota(user) }, sessionHeaders(user));
  }
  if (method === 'POST' && url === '/api/auth/logout') { const secure = process.env.SECURE_COOKIES === 'true' || process.env.SSL_KEY_PATH; sessions.delete(cookie(req).fm_session); return json(res, 200, { ok: true }, { 'Set-Cookie': `fm_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure ? '; Secure' : ''}` }); }
  if (method === 'POST' && url === '/api/auth/reset') return json(res, 200, { message: 'Якщо акаунт існує, інструкцію буде надіслано. Для реального email-відновлення підключи SMTP у продакшені.' });
  const user = currentUser(req);
  if (!user) return json(res, 401, { error: 'Потрібна авторизація.' });
  if (method === 'GET' && url === '/api/me') return json(res, 200, { user: publicUser(user), data: user.data || emptyData(user.name), coach: coachQuota(user) });
  if (method === 'PUT' && url === '/api/profile') {
    const input = await readBody(req), rawUsername = textValue(input?.username, 24), username = normalizedUsername(rawUsername);
    if (rawUsername && !isUsername(username)) return json(res, 400, { error: 'Нікнейм: 3–24 літери, цифри або _.' });
    const db = database(), stored = db.users.find(item => item.id === user.id);
    if (!stored) return json(res, 401, { error: 'Потрібна авторизація.' });
    if (rawUsername && username !== normalizedUsername(stored.username)) {
      if (db.users.some(item => item.id !== stored.id && normalizedUsername(item.username) === username)) return json(res, 409, { error: 'Цей нікнейм уже зайнятий.' });
      stored.username = username;
      saveDatabase(db);
    }
    return json(res, 200, { user: publicUser(stored) });
  }
  if (method === 'PUT' && url === '/api/data') { const input = await readBody(req); const db = database(); const stored = db.users.find(item => item.id === user.id); const data = stored ? cleanUserData(input, stored.name) : null; if (!data) return json(res, 400, { error: 'Некоректні дані.' }); stored.data = data; saveDatabase(db); return json(res, 200, { ok: true }); }
  if (method === 'POST' && url === '/api/coach') {
    const body = await readBody(req);
    const question = String(body?.question || '').trim().slice(0, 500);
    const history = Array.isArray(body?.history) ? body.history.slice(-8).map(item => ({ role: item?.role === 'model' ? 'model' : 'user', text: String(item?.text || '').slice(0, 900) })).filter(item => item.text) : [];
    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    if (!question) return json(res, 400, { error: 'Обери питання для тренера.' });
    const quota = consumeCoachRequest(user.id);
    if (!quota || quota.exhausted) return json(res, 200, { available: false, state: 'quota', limit: coachDailyLimit, remaining: 0 });
    if (!apiKey) return json(res, 200, { available: false, state: 'key', limit: quota.limit, remaining: quota.remaining });
    const allWorkouts = user.data?.workouts || [];
    const workouts = allWorkouts.slice(0, 8).map(workout => ({
      date: workout.completedAt,
      duration: workout.duration,
      exercises: (workout.exercises || []).map(exercise => ({ name: exercise.name, sets: (exercise.sets || []).length }))
    }));
    const context = JSON.stringify({ profile: user.data?.profile || {}, recovery: recoveryForCoach(allWorkouts), recentWorkouts: workouts });
    const conversation = [
      { role: 'user', parts: [{ text: `Ось актуальний контекст користувача FitMind. Спирайся на нього в усій розмові, але не переказуй JSON дослівно: ${context}` }] },
      { role: 'model', parts: [{ text: 'Контекст FitMind отримано. Відповідатиму природно та врахую журнал і відновлення.' }] },
      ...history.map(item => ({ role: item.role, parts: [{ text: item.text }] })),
      { role: 'user', parts: [{ text: question }] }
    ];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: 'Ти FitMind — живий, уважний персональний фітнес-помічник українською. Розмовляй природно на «ти», без шаблонних фраз, як хороший тренер. Враховуй попередні репліки з history, щоб підтримувати діалог. Відповідай максимум 120 словами, але НІКОЛИ не обривай думку: закінчуй останнє речення крапкою. Спочатку дай короткий висновок, далі конкретний план з вправами, сетами й повторами, якщо це доречно. Використовуй короткі абзаци та прості списки; не показуй службові міркування, JSON або технічні пояснення. ОСНОВНЕ ПРАВИЛО: у даних є поле recovery з реально розрахованими процентами відновлення. Перед порадою завжди проаналізуй його: назви загальну готовність і релевантні м’язи. Не радь важко навантажувати м’яз нижче 70%; нижче 50% порадь відпочинок або іншу групу. Пропонуй вправи лише для достатньо відновлених м’язів. Не вигадуй показники, не став діагнозів. Якщо є біль, травма або погане самопочуття — порадь звернутися до лікаря чи тренера.' }] },
          contents: conversation,
          generationConfig: { maxOutputTokens: 2000, thinkingConfig: { thinkingLevel: 'LOW' } }
        })
      });
      const result = await response.json().catch(() => ({}));
      const candidate = result?.candidates?.[0];
      const answer = candidate?.content?.parts?.filter(part => !part.thought).map(part => part.text || '').join('').trim();
      const endedNormally = !candidate?.finishReason || candidate.finishReason === 'STOP';
      if (!response.ok || !answer || !endedNormally || !isCompleteCoachAnswer(answer)) {
        const detail = String(result?.error?.message || 'Модель не повернула відповідь.').replace(/[\r\n]+/g, ' ').slice(0, 220);
        console.warn(`[Gemini ${response.status}] ${detail}`);
        const state = !response.ok ? (response.status === 429 || response.status === 503 ? 'limit' : 'error') : 'incomplete';
        return json(res, 200, { available: false, state, detail, limit: quota.limit, remaining: quota.remaining });
      }
      return json(res, 200, { available: true, answer: answer.slice(0, 2400), limit: quota.limit, remaining: quota.remaining });
    } catch (error) {
      const detail = error?.name === 'AbortError' ? 'Час очікування Gemini вичерпано.' : 'Не вдалося з’єднатися з Gemini.';
      console.warn(`[Gemini] ${detail}`);
      return json(res, 200, { available: false, state: 'network', detail, limit: quota.limit, remaining: quota.remaining });
    } finally { clearTimeout(timer); }
  }
  return json(res, 404, { error: 'Не знайдено.' });
};
const preferredPort = Number(process.env.PORT) || 4173;
const hasCertificate = process.env.SSL_KEY_PATH && process.env.SSL_CERT_PATH;
const server = hasCertificate
  ? https.createServer({ key: fs.readFileSync(process.env.SSL_KEY_PATH), cert: fs.readFileSync(process.env.SSL_CERT_PATH) }, handler)
  : http.createServer(handler);
function start(port) { server.once('error', error => { if (error.code === 'EADDRINUSE') return start(port + 1); throw error; }); server.listen(port, () => { const url=`${hasCertificate ? 'https' : 'http'}://localhost:${port}`; console.log(`FitMind: ${url}`); if(process.platform==='win32' && process.env.FITMIND_NO_OPEN !== 'true') require('child_process').exec(`start "" "${url}"`); }); }
start(preferredPort);
