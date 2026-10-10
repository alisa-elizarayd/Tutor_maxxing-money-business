/* Tutor Maxxing: complete cloud state sync.
 * Syncs every tutor* localStorage key, not just calendar/finance.
 * The publishable key is safe for the browser; RLS scopes rows to auth.uid().
 */
(() => {
  'use strict';

  const CONFIG = window.TUTOR_SUPABASE_CONFIG || {};
  const SUPABASE_URL = CONFIG.url || '';
  const SUPABASE_PUBLISHABLE_KEY = CONFIG.publishableKey || '';
  const CDN = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/+esm';
  const DATA_TABLE = 'user_data';
  const SNAPSHOT_ID = 'app_state';
  const LEGACY_KEYS = {
    calendar: 'tutorLessonsPro',
    finance: 'tutor_mvp_state_v5'
  };

  let client = null;
  let user = null;
  let channel = null;
  let syncTimer = null;
  let applyingRemote = false;
  let lastUploaded = '';
  let watchStarted = false;

  function parseValue(raw) {
    if (raw == null) return null;
    try { return JSON.parse(raw); } catch { return raw; }
  }

  function snapshotLocal() {
    const snapshot = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith('tutor')) snapshot[key] = parseValue(localStorage.getItem(key));
    }
    return snapshot;
  }

  function writeSnapshot(snapshot) {
    for (const [key, value] of Object.entries(snapshot || {})) {
      if (!key.startsWith('tutor')) continue;
      localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
    }
  }

  function keyOf(value, fallback) {
    return String(value?.id || fallback || '').trim();
  }

  function nameOf(value) {
    return String(value?.name || '').trim().toLocaleLowerCase();
  }

  function mergeUnique(remoteItems, localItems, identity) {
    const result = [];
    const index = new Map();
    for (const item of [...(localItems || []), ...(remoteItems || [])]) {
      if (!item || typeof item !== 'object') continue;
      const id = identity(item);
      if (!id) { result.push(item); continue; }
      if (index.has(id)) result[index.get(id)] = { ...result[index.get(id)], ...item };
      else { index.set(id, result.length); result.push(item); }
    }
    return result;
  }

  function mergeStudent(remoteStudent, localStudent, calendarLessons) {
    const local = localStudent || {};
    const remote = remoteStudent || {};
    const merged = { ...local, ...remote };
    merged.days = Array.from(new Set([...(local.days || []), ...(remote.days || [])]));
    merged.scheduleSlots = mergeUnique(remote.scheduleSlots, local.scheduleSlots,
      slot => slot?.day && slot?.time ? slot.day + '|' + slot.time : '');
    merged.payments = mergeUnique(remote.payments, local.payments, item => keyOf(item));
    merged.notes = mergeUnique(remote.notes, local.notes, item => keyOf(item));
    merged.lessons = mergeUnique(remote.lessons, local.lessons,
      lesson => keyOf(lesson, lesson?.date));
    merged.lessons = merged.lessons || [];

    for (const calendarLesson of calendarLessons || []) {
      const sameStudent = (calendarLesson.financeStudentId && calendarLesson.financeStudentId === merged.id)
        || nameOf(calendarLesson) === nameOf(merged);
      if (!sameStudent) continue;
      const lessonId = calendarLesson.financeLessonId || 'calendar-' + keyOf(calendarLesson);
      if (!merged.lessons.some(lesson => keyOf(lesson) === lessonId || lesson.date === calendarLesson.date)) {
        merged.lessons.push({
          id: lessonId,
          date: calendarLesson.date,
          status: calendarLesson.financeStatus || 'planned',
          manualPaid: !!calendarLesson.manualPaid,
          paymentId: null,
          entitlementId: lessonId,
          calendarLessonId: calendarLesson.id
        });
      }
    }
    return merged;
  }

  function mergeFinance(remoteFinance, localFinance, calendarLessons) {
    const local = localFinance && typeof localFinance === 'object' ? localFinance : {};
    const remote = remoteFinance && typeof remoteFinance === 'object' ? remoteFinance : {};
    const merged = { ...local, ...remote };
    const localStudents = Array.isArray(local.students) ? local.students : [];
    const remoteStudents = Array.isArray(remote.students) ? remote.students : [];
    const students = [];
    const positions = new Map();

    for (const student of [...localStudents, ...remoteStudents]) {
      const identity = keyOf(student) || nameOf(student);
      if (!identity) continue;
      if (positions.has(identity)) {
        const index = positions.get(identity);
        students[index] = mergeStudent(student, students[index], calendarLessons);
      } else {
        positions.set(identity, students.length);
        students.push(mergeStudent(student, null, calendarLessons));
      }
    }

    // Calendar can contain students that were never created in the finance tab.
    // Promote them into finance state so every device receives the full roster.
    for (const lesson of calendarLessons || []) {
      const identity = lesson.financeStudentId || nameOf(lesson);
      if (!identity || students.some(student => keyOf(student) === identity || nameOf(student) === identity)) continue;
      const derived = {
        id: lesson.financeStudentId || 'calendar-student-' + nameOf(lesson).replace(/[^a-z0-9а-яё]+/gi, '-'),
        name: lesson.name || 'Без имени',
        rate: Number(lesson.rate) || 0,
        days: [],
        time: lesson.time || '',
        payments: [],
        lessons: [],
        balance: 0,
        scheduleSlots: [],
        scheduleStart: lesson.date || null
      };
      students.push(mergeStudent(derived, null, calendarLessons));
    }

    merged.students = students;
    merged.notes = mergeUnique(remote.notes, local.notes, item => keyOf(item));
    if (!Array.isArray(merged.notes)) merged.notes = [];
    return merged;
  }

  function mergeSnapshots(remoteSnapshot, localSnapshot, legacyRows) {
    const remote = remoteSnapshot && typeof remoteSnapshot === 'object' ? remoteSnapshot : {};
    const local = localSnapshot && typeof localSnapshot === 'object' ? localSnapshot : {};
    const legacyCalendar = legacyRows?.calendar || {};
    const legacyFinance = legacyRows?.finance || {};
    const calendar = mergeUnique(
      remote.tutorLessonsPro || legacyCalendar,
      local.tutorLessonsPro,
      item => keyOf(item)
    );
    const finance = mergeFinance(
      remote.tutor_mvp_state_v5 || legacyFinance,
      local.tutor_mvp_state_v5,
      calendar
    );
    return {
      ...local,
      ...remote,
      tutorLessonsPro: calendar,
      tutor_mvp_state_v5: finance
    };
  }

  function notifyApp() {
    window.dispatchEvent(new Event('finance-state-changed'));
    window.dispatchEvent(new Event('calendar-state-changed'));
  }

  function setMessage(text, type = '') {
    const el = document.getElementById('tutorAuthMessage');
    if (el) {
      el.textContent = text;
      el.className = 'tutor-auth-message ' + type;
    }
  }

  function setBusy(value) {
    document.querySelectorAll('#tutorAuthModal button').forEach(button => { button.disabled = value; });
  }

  function ensureAuthUI() {
    if (document.getElementById('tutorAuthModal')) return;
    const style = document.createElement('style');
    style.textContent = `
      #tutorAuthBar{position:fixed;top:12px;right:14px;z-index:10000;display:flex;gap:8px;align-items:center}
      #tutorAuthOpen{border:1px solid #4caf50;background:#fff;color:#2d6d34;border-radius:10px;padding:8px 12px;cursor:pointer;font-weight:700;box-shadow:0 2px 10px #0002}
      #tutorAuthStatus{font-size:12px;color:#2d6d34;background:#fff;border-radius:9px;padding:7px 9px;box-shadow:0 2px 10px #0002;max-width:230px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      #tutorAuthModal{position:fixed;inset:0;z-index:10001;display:none;place-items:center;background:#0008;padding:16px}
      #tutorAuthModal.open{display:grid}.tutor-auth-card{width:min(410px,100%);background:#fff;border-radius:16px;padding:22px;box-shadow:0 18px 60px #0005}
      .tutor-auth-card h2{margin:0 0 8px;color:#2d6d34;font-size:22px}.tutor-auth-card p{margin:0 0 16px;color:#555;line-height:1.45}
      .tutor-auth-card input{width:100%;padding:11px;border:1px solid #ccc;border-radius:9px;margin:0 0 10px;font:inherit}
      .tutor-auth-actions{display:flex;gap:8px;flex-wrap:wrap}.tutor-auth-actions button{flex:1;min-width:130px;padding:10px;border:0;border-radius:9px;cursor:pointer;font-weight:700}
      #tutorSignIn{background:#4caf50;color:#fff}.tutorSignUp{background:#e8f5e9;color:#2d6d34}#tutorSignOut{background:#f5f5f5;color:#555;display:none}
      .tutorAuthClose{float:right;border:0;background:none;font-size:24px;cursor:pointer;color:#777}.tutor-auth-message{min-height:22px;margin:12px 0 0;font-size:13px}
      .tutor-auth-message.ok{color:#2d6d34}.tutor-auth-message.error{color:#b3261e}@media(max-width:600px){#tutorAuthBar{top:8px;right:8px}#tutorAuthStatus{display:none}}
    `;
    document.head.appendChild(style);
    document.body.insertAdjacentHTML('beforeend', `
      <div id="tutorAuthBar"><span id="tutorAuthStatus">☁️ Локальный режим</span><button id="tutorAuthOpen">☁️ Войти</button></div>
      <div id="tutorAuthModal" aria-hidden="true"><div class="tutor-auth-card">
        <button class="tutorAuthClose" id="tutorAuthClose" aria-label="Закрыть">×</button>
        <h2>☁️ Облачная синхронизация</h2>
        <p>Создайте аккаунт, подтвердите email и синхронизируйте все данные приложения на всех устройствах.</p>
        <input id="tutorAuthEmail" type="email" autocomplete="email" placeholder="Email">
        <input id="tutorAuthPassword" type="password" autocomplete="current-password" placeholder="Пароль (минимум 6 символов)">
        <div class="tutor-auth-actions"><button id="tutorSignIn">Войти</button><button class="tutorSignUp" id="tutorSignUp">Создать аккаунт</button><button id="tutorSignOut">Выйти</button></div>
        <div id="tutorAuthMessage" class="tutor-auth-message" aria-live="polite"></div>
      </div></div>
    `);
    const modal = document.getElementById('tutorAuthModal');
    document.getElementById('tutorAuthOpen').onclick = () => modal.classList.add('open');
    document.getElementById('tutorAuthClose').onclick = () => modal.classList.remove('open');
    modal.onclick = event => { if (event.target === modal) modal.classList.remove('open'); };
    document.getElementById('tutorSignIn').onclick = signIn;
    document.getElementById('tutorSignUp').onclick = signUp;
    document.getElementById('tutorSignOut').onclick = signOut;
  }

  function updateAuthUI() {
    const status = document.getElementById('tutorAuthStatus');
    const open = document.getElementById('tutorAuthOpen');
    if (!status || !open) return;
    const controls = {
      signIn: document.getElementById('tutorSignIn'),
      signUp: document.getElementById('tutorSignUp'),
      signOut: document.getElementById('tutorSignOut')
    };
    if (user) {
      status.textContent = '☁️ ' + (user.email || 'Аккаунт');
      open.textContent = '☁️ Аккаунт';
      controls.signIn.style.display = 'none'; controls.signUp.style.display = 'none'; controls.signOut.style.display = 'block';
    } else {
      status.textContent = '☁️ Локальный режим';
      open.textContent = '☁️ Войти';
      controls.signIn.style.display = ''; controls.signUp.style.display = ''; controls.signOut.style.display = 'none';
    }
  }

  async function signIn() {
    const email = document.getElementById('tutorAuthEmail').value.trim();
    const password = document.getElementById('tutorAuthPassword').value;
    if (!email || !password) return setMessage('Введите email и пароль.', 'error');
    if (!client) return setMessage('Облачный сервис ещё загружается.', 'error');
    setBusy(true); setMessage('Выполняется вход…');
    try {
      const { error } = await client.auth.signInWithPassword({ email, password });
      if (error) throw error;
      setMessage('Вход выполнен. Синхронизация запущена.', 'ok');
    } catch (error) { setMessage(error.message || 'Не удалось войти.', 'error'); }
    finally { setBusy(false); }
  }

  async function signUp() {
    const email = document.getElementById('tutorAuthEmail').value.trim();
    const password = document.getElementById('tutorAuthPassword').value;
    if (!email || !password) return setMessage('Введите email и пароль.', 'error');
    if (password.length < 6) return setMessage('Пароль должен содержать минимум 6 символов.', 'error');
    if (!client) return setMessage('Облачный сервис ещё загружается.', 'error');
    setBusy(true); setMessage('Создаём аккаунт…');
    try {
      const { data, error } = await client.auth.signUp({ email, password, options: { emailRedirectTo: window.location.href } });
      if (error) throw error;
      setMessage(data.session ? 'Аккаунт создан. Синхронизация запущена.' : 'Аккаунт создан. Проверьте почту и подтвердите email, затем войдите.', 'ok');
    } catch (error) { setMessage(error.message || 'Не удалось создать аккаунт.', 'error'); }
    finally { setBusy(false); }
  }

  async function signOut() {
    if (!client) return;
    setBusy(true);
    try { await client.auth.signOut(); }
    finally { setBusy(false); document.getElementById('tutorAuthModal').classList.remove('open'); }
  }

  async function uploadSnapshot(snapshot) {
    if (!user || applyingRemote) return;
    const serialized = JSON.stringify(snapshot);
    if (serialized === lastUploaded) return;
    const { error } = await client.from(DATA_TABLE).upsert(
      { user_id: user.id, id: SNAPSHOT_ID, data: snapshot, updated_at: new Date().toISOString() },
      { onConflict: 'user_id,id' }
    );
    if (error) throw error;
    // Keep legacy rows populated for backwards compatibility with previous clients.
    await client.from(DATA_TABLE).upsert([
      { user_id: user.id, id: 'calendar', data: snapshot.tutorLessonsPro || [], updated_at: new Date().toISOString() },
      { user_id: user.id, id: 'finance', data: snapshot.tutor_mvp_state_v5 || {}, updated_at: new Date().toISOString() }
    ], { onConflict: 'user_id,id' });
    lastUploaded = serialized;
  }

  async function loadRemote() {
    const { data, error } = await client.from(DATA_TABLE).select('id,data,updated_at').eq('user_id', user.id);
    if (error) throw error;
    const legacyRows = {};
    let remoteSnapshot = {};
    for (const row of data || []) {
      if (row.id === SNAPSHOT_ID) remoteSnapshot = row.data || {};
      if (row.id === 'calendar') legacyRows.calendar = row.data || [];
      if (row.id === 'finance') legacyRows.finance = row.data || {};
    }
    const merged = mergeSnapshots(remoteSnapshot, snapshotLocal(), legacyRows);
    applyingRemote = true;
    writeSnapshot(merged);
    applyingRemote = false;
    notifyApp();
    await uploadSnapshot(merged);
  }

  function scheduleSync() {
    if (!user || applyingRemote) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(async () => {
      try {
        const local = snapshotLocal();
        await uploadSnapshot(local);
      } catch (error) { console.warn('Tutor cloud sync failed:', error); }
    }, 700);
  }

  function setupRealtime() {
    if (channel) client.removeChannel(channel);
    channel = client.channel('tutor-user-data-' + user.id)
      .on('postgres_changes', { event: '*', schema: 'public', table: DATA_TABLE, filter: 'user_id=eq.' + user.id },
        payload => {
          if (payload.new?.id !== SNAPSHOT_ID || !payload.new?.data) return;
          const incoming = payload.new.data;
          if (JSON.stringify(incoming) === lastUploaded) return;
          const merged = mergeSnapshots(incoming, snapshotLocal(), {});
          applyingRemote = true;
          writeSnapshot(merged);
          applyingRemote = false;
          lastUploaded = JSON.stringify(merged);
          notifyApp();
        })
      .subscribe();
  }

  async function onSession(session) {
    user = session?.user || null;
    updateAuthUI();
    if (!user) {
      if (channel) { client.removeChannel(channel); channel = null; }
      lastUploaded = '';
      return;
    }
    try {
      await loadRemote();
      setupRealtime();
      setMessage('Облако синхронизировано.', 'ok');
    } catch (error) {
      console.warn('Tutor cloud initialization failed:', error);
      setMessage('Облако недоступно: ' + (error.message || 'ошибка синхронизации'), 'error');
    }
  }

  function startLocalWatch() {
    if (watchStarted) return;
    watchStarted = true;
    let previous = JSON.stringify(snapshotLocal());
    setInterval(() => {
      if (!user || applyingRemote) return;
      const current = JSON.stringify(snapshotLocal());
      if (current !== previous) { previous = current; scheduleSync(); }
    }, 1200);
    window.addEventListener('finance-state-changed', scheduleSync);
    window.addEventListener('calendar-state-changed', scheduleSync);
  }

  async function init() {
    ensureAuthUI();
    updateAuthUI();
    if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY || SUPABASE_URL.includes('__SUPABASE')) {
      setMessage('Supabase ещё не подключён.', 'error');
      return;
    }
    try {
      const module = await import(CDN);
      client = module.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
      client.auth.onAuthStateChange((_event, session) => { onSession(session); });
      const { data } = await client.auth.getSession();
      await onSession(data.session);
      startLocalWatch();
    } catch (error) {
      console.warn('Supabase SDK initialization failed:', error);
      setMessage('Не удалось загрузить облачный сервис.', 'error');
    }
  }

  window.tutorCloud = { init, scheduleSync };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
