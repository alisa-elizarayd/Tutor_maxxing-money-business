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
  const SYNC_BASE_KEY = 'tutorSyncBase';
  const SYNC_OWNER_KEY = 'tutorSyncOwner';
  const LEGACY_KEYS = {
    calendar: 'tutorLessonsPro',
    finance: 'tutor_mvp_state_v5'
  };
  // Background photos can be multi-megabyte data URLs. Sync lightweight
  // background patterns, but keep uploaded photos local to avoid quota errors.
  const LOCAL_ONLY_KEYS = new Set([SYNC_BASE_KEY, SYNC_OWNER_KEY]);

  let client = null;
  let user = null;
  let channel = null;
  let syncTimer = null;
  let applyingRemote = false;
  let lastUploaded = '';
  let syncState = 'offline';
  let watchStarted = false;
  let syncInFlight = false;
  let syncQueued = false;
  let loadingUserId = null;
  let remoteUpdatedAt = null;

  function parseValue(raw) {
    if (raw == null) return null;
    try { return JSON.parse(raw); } catch { return raw; }
  }

  function snapshotLocal() {
    const snapshot = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith('tutor') && !LOCAL_ONLY_KEYS.has(key)) {
        if (key === 'tutorBg' && localStorage.getItem(key)?.startsWith('data:image')) {
          const cloudPattern = readSyncBase()?.tutorBg;
          if (cloudPattern && !String(cloudPattern).startsWith('data:image')) snapshot[key] = cloudPattern;
          continue;
        }
        snapshot[key] = parseValue(localStorage.getItem(key));
      }
    }
    return snapshot;
  }

  function snapshotSignature(snapshot) {
    const normalize = value => {
      if (Array.isArray(value)) return value.map(normalize);
      if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key])]));
      }
      return value;
    };
    return JSON.stringify(normalize(snapshot));
  }

  function readSyncBase() {
    try {
      const raw = localStorage.getItem(SYNC_BASE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  function saveSyncBase(snapshot) {
    try {
      localStorage.setItem(SYNC_BASE_KEY, snapshotSignature(snapshot));
      if (user) localStorage.setItem(SYNC_OWNER_KEY, user.id);
    } catch {}
  }

  function hasAppContent(snapshot) {
    const calendar = Array.isArray(snapshot?.tutorLessonsPro) ? snapshot.tutorLessonsPro : [];
    const finance = snapshot?.tutor_mvp_state_v5 && typeof snapshot.tutor_mvp_state_v5 === 'object'
      ? snapshot.tutor_mvp_state_v5
      : {};
    const students = Array.isArray(finance.students) ? finance.students : [];
    const notes = Array.isArray(finance.notes) ? finance.notes : [];
    return calendar.length > 0 || students.length > 0 || notes.length > 0;
  }

  function writeSnapshot(snapshot) {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key && key.startsWith('tutor') && !LOCAL_ONLY_KEYS.has(key) &&
          !Object.prototype.hasOwnProperty.call(snapshot || {}, key)) {
        if (key === 'tutorBg' && localStorage.getItem(key)?.startsWith('data:image')) continue;
        localStorage.removeItem(key);
      }
    }
    for (const [key, value] of Object.entries(snapshot || {})) {
      if (!key.startsWith('tutor') || LOCAL_ONLY_KEYS.has(key)) continue;
      if (key === 'tutorBg' && localStorage.getItem(key)?.startsWith('data:image')) continue;
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
    const legacyCalendar = Array.isArray(legacyRows?.calendar) ? legacyRows.calendar : [];
    const legacyFinance = legacyRows?.finance && typeof legacyRows.finance === 'object'
      ? legacyRows.finance
      : {};

    // An older/empty app_state row must not hide useful legacy data. This is
    // important during first login from a fresh browser, where localStorage is
    // empty and a stale race could otherwise upload an empty snapshot.
    const remoteCalendar = Array.isArray(remote.tutorLessonsPro) ? remote.tutorLessonsPro : [];
    const calendarSource = remoteCalendar.length ? remoteCalendar : legacyCalendar;
    const remoteFinance = remote.tutor_mvp_state_v5 && typeof remote.tutor_mvp_state_v5 === 'object'
      ? remote.tutor_mvp_state_v5
      : {};
    const remoteHasFinance = (Array.isArray(remoteFinance.students) && remoteFinance.students.length > 0)
      || (Array.isArray(remoteFinance.notes) && remoteFinance.notes.length > 0);
    const financeSource = remoteHasFinance ? remoteFinance : legacyFinance;

    const calendar = mergeUnique(
      calendarSource,
      local.tutorLessonsPro,
      item => keyOf(item)
    );
    const finance = mergeFinance(
      financeSource,
      local.tutor_mvp_state_v5,
      calendar
    );
    const mergedBase = { ...local, ...remote };
    for (const key of LOCAL_ONLY_KEYS) delete mergedBase[key];
    return {
      ...mergedBase,
      tutorLessonsPro: calendar,
      tutor_mvp_state_v5: finance
    };
  }

  function mergeThreeWay(base, local, remote) {
    if (snapshotSignature(local) === snapshotSignature(remote)) return local;
    if (snapshotSignature(local) === snapshotSignature(base)) return remote;
    if (snapshotSignature(remote) === snapshotSignature(base)) return local;

    if (Array.isArray(local) && Array.isArray(remote)) {
      const identity = item => {
        if (!item || typeof item !== 'object') return 'value:' + snapshotSignature(item);
        return String(item.id || (item.day && item.time && item.day + '|' + item.time) ||
          (item.date && 'date:' + item.date) || (item.name && 'name:' + nameOf(item)) ||
          'value:' + snapshotSignature(item));
      };
      const byId = values => new Map((Array.isArray(values) ? values : []).map(item => [identity(item), item]));
      const baseMap = byId(base);
      const localMap = byId(local);
      const remoteMap = byId(remote);
      const orderedIds = [...new Set([...localMap.keys(), ...remoteMap.keys()])];
      const merged = [];
      for (const id of orderedIds) {
        const wasSynced = baseMap.has(id);
        // A deletion on either device wins over a stale copy of that item.
        if (wasSynced && (!localMap.has(id) || !remoteMap.has(id))) continue;
        if (localMap.has(id) && remoteMap.has(id)) {
          merged.push(mergeThreeWay(baseMap.get(id), localMap.get(id), remoteMap.get(id)));
        } else if (localMap.has(id)) merged.push(localMap.get(id));
        else merged.push(remoteMap.get(id));
      }
      return merged;
    }

    const isObject = value => value && typeof value === 'object' && !Array.isArray(value);
    if (isObject(local) && isObject(remote)) {
      const merged = {};
      for (const key of new Set([...Object.keys(local), ...Object.keys(remote)])) {
        const inBase = isObject(base) && Object.prototype.hasOwnProperty.call(base, key);
        const inLocal = Object.prototype.hasOwnProperty.call(local, key);
        const inRemote = Object.prototype.hasOwnProperty.call(remote, key);
        if (inBase && (!inLocal || !inRemote)) continue;
        if (inLocal && inRemote) merged[key] = mergeThreeWay(base?.[key], local[key], remote[key]);
        else if (inLocal) merged[key] = local[key];
        else merged[key] = remote[key];
      }
      return merged;
    }

    // Both sides changed the same scalar; keep the latest cloud value.
    return remote;
  }

  function mergeCanonical(base, local, remote) {
    const merged = mergeThreeWay(base, local, remote);
    const before = new Set((base.tutor_mvp_state_v5?.students || []).map(student => student.id));
    const after = new Set((merged.tutor_mvp_state_v5?.students || []).map(student => student.id));
    const deletedStudents = new Set([...before].filter(id => id && !after.has(id)));
    if (deletedStudents.size && Array.isArray(merged.tutorLessonsPro)) {
      merged.tutorLessonsPro = merged.tutorLessonsPro.filter(lesson =>
        !deletedStudents.has(lesson.financeStudentId));
    }
    return merged;
  }

  function resolveSnapshot(remoteSnapshot, localSnapshot, legacyRows) {
    const remote = remoteSnapshot && typeof remoteSnapshot === 'object' ? remoteSnapshot : {};
    const local = localSnapshot && typeof localSnapshot === 'object' ? localSnapshot : {};
    const base = readSyncBase();
    const hasCanonicalRemote = Object.prototype.hasOwnProperty.call(remote, 'tutorLessonsPro') ||
      Object.prototype.hasOwnProperty.call(remote, 'tutor_mvp_state_v5');

    // Empty canonical arrays are meaningful: they can represent an intentional
    // "delete all". Never resurrect stale browser cache data into that state.
    if (!base && hasCanonicalRemote) return remote;
    if (base && hasCanonicalRemote) return mergeCanonical(base, local, remote);
    return mergeSnapshots(remote, local, legacyRows);
  }

  function needsInitialChoice(remote, local, base, sameAccount) {
    return sameAccount && !base && hasAppContent(local) &&
      snapshotSignature(remote) !== snapshotSignature(local);
  }

  function chooseInitialSource(remote, local) {
    const count = snapshot => {
      const students = snapshot?.tutor_mvp_state_v5?.students;
      const lessons = snapshot?.tutorLessonsPro;
      return `${Array.isArray(students) ? students.length : 0} учеников, ${Array.isArray(lessons) ? lessons.length : 0} уроков`;
    };
    const dialog = document.getElementById('tutorInitialSyncModal');
    const description = document.getElementById('tutorInitialSyncDescription');
    description.textContent = `На этом устройстве: ${count(local)}. В облаке: ${count(remote)}. Выбор облака заменит местные данные. Объединение может вернуть учеников, ранее удалённых на другом устройстве.`;
    dialog.classList.add('open');
    return new Promise(resolve => {
      const finish = mergeLocal => {
        dialog.classList.remove('open');
        document.getElementById('tutorAuthModal').classList.remove('open');
        resolve(mergeLocal);
      };
      document.getElementById('tutorUseCloud').onclick = () => finish(false);
      document.getElementById('tutorMergeDevice').onclick = () => finish(true);
    });
  }

  function notifyApp() {
    window.dispatchEvent(new Event('finance-state-changed'));
    window.dispatchEvent(new Event('calendar-state-changed'));
  }

  function setSyncStatus(state, detail = '') {
    syncState = state;
    const status = document.getElementById('tutorSyncStatus');
    const text = document.getElementById('tutorSyncStatusText');
    if (!status || !text) return;
    const labels = {
      syncing: 'Статус: Синхронизируется…',
      synced: 'Статус: Синхронизировано',
      offline: 'Статус: Офлайн',
      error: 'Статус: Ошибка синхронизации'
    };
    const resolved = detail || labels[state] || labels.offline;
    text.textContent = resolved;
    status.dataset.state = state;
    status.title = resolved;
    status.setAttribute('aria-label', resolved);
    const bar = document.getElementById('tutorAuthBar');
    if (bar) bar.dataset.state = state;
    const toggleText = document.getElementById('tutorCloudToggleText');
    if (toggleText) toggleText.textContent = resolved.replace(/^Статус:\s*/, '');
    const issue = document.getElementById('tutorSyncError');
    if (issue && state !== 'error') { issue.textContent = ''; issue.hidden = true; }
  }

  function describeSyncError(error) {
    const message = String(error?.message || error || 'Неизвестная ошибка');
    if (error?.name === 'QuotaExceededError' || /quota has been exceeded|storage quota/i.test(message)) {
      return 'Память браузера заполнена. Уменьшите или удалите фоновое изображение в настройках календаря и повторите синхронизацию.';
    }
    return message;
  }

  function setSyncError(error) {
    setSyncStatus('error');
    const issue = document.getElementById('tutorSyncError');
    if (issue) { issue.textContent = describeSyncError(error); issue.hidden = false; }
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
      #tutorAuthBar{position:relative;z-index:10000;font-family:inherit;flex:0 0 auto;align-self:center}
      #tutorCloudToggle{display:inline-flex;align-items:center;gap:7px;max-width:min(340px,calc(100vw - 20px));padding:8px 12px;border:1px solid rgba(255,255,255,.8);border-radius:999px;background:rgba(255,255,255,.96);color:#245b2b;box-shadow:0 2px 12px #0003;cursor:pointer;font:700 13px/1.2 inherit}
      #tutorCloudToggle:hover{box-shadow:0 4px 16px #0004;transform:translateY(-1px)}
      #tutorCloudToggle .tutor-cloud-icon{font-size:14px;line-height:1}
      #tutorCloudToggle .tutor-cloud-dot{width:8px;height:8px;border-radius:50%;background:#666;flex:0 0 auto}
      #tutorCloudToggle .tutor-chevron{font-size:15px;line-height:1;opacity:.65;transition:transform .18s}
      #tutorAuthBar.open #tutorCloudToggle .tutor-chevron{transform:rotate(180deg)}
      #tutorCloudToggleText{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      #tutorAuthBar[data-state="synced"] #tutorCloudToggle{color:#176b2a;background:#eef9ef}
      #tutorAuthBar[data-state="syncing"] #tutorCloudToggle{color:#7a5600;background:#fff8dc}
      #tutorAuthBar[data-state="offline"] #tutorCloudToggle{color:#666;background:#f3f3f3}
      #tutorAuthBar[data-state="error"] #tutorCloudToggle{color:#a62222;background:#fff0f0}
      #tutorAuthBar[data-state="synced"] .tutor-cloud-dot{background:#1f9d45}
      #tutorAuthBar[data-state="syncing"] .tutor-cloud-dot{background:#d39b00}
      #tutorAuthBar[data-state="offline"] .tutor-cloud-dot{background:#777}
      #tutorAuthBar[data-state="error"] .tutor-cloud-dot{background:#c62828}
      #tutorCloudPanel{display:none;position:absolute;top:calc(100% + 8px);right:0;width:min(340px,calc(100vw - 20px));padding:10px;background:#fff;border:1px solid #e6e0eb;border-radius:14px;box-shadow:0 10px 28px #0003}
      #tutorAuthBar.open #tutorCloudPanel{display:block}
      #tutorAccountStatus,#tutorSyncStatus{display:flex;align-items:center;gap:7px;width:100%;background:#faf9fc;border-radius:10px;padding:9px 10px;font-size:13px;font-weight:700;white-space:nowrap}
      #tutorAccountStatus{color:#245b2b;overflow:hidden;text-overflow:ellipsis}
      #tutorSyncStatus{color:#555;margin-top:7px}
      #tutorSyncStatus[data-state="synced"]{color:#176b2a;background:#eef9ef}
      #tutorSyncStatus[data-state="syncing"]{color:#7a5600;background:#fff8dc}
      #tutorSyncStatus[data-state="offline"]{color:#666;background:#f3f3f3}
      #tutorSyncStatus[data-state="error"]{color:#a62222;background:#fff0f0}
      #tutorSyncError{margin-top:7px;padding:9px 10px;border-radius:9px;background:#fff0f0;color:#a62222;font-size:12px;line-height:1.4;overflow-wrap:anywhere}
      .tutor-status-dot{width:9px;height:9px;border-radius:50%;background:currentColor;flex:0 0 auto}
      .tutor-menu-actions{display:flex;gap:7px;margin-top:9px}
      #tutorAuthBar .tutor-menu-actions button{flex:1;min-width:0;display:inline-flex;align-items:center;justify-content:center;border:1px solid #4caf50;background:#fff;color:#245b2b;border-radius:9px;padding:9px 10px;cursor:pointer;font-size:12px;font-weight:700;white-space:nowrap}
      #tutorAuthBar .tutor-menu-actions button:hover{filter:brightness(.98);transform:translateY(-1px)}
      #tutorAuthBar #tutorLogout{background:#fff4f4;border-color:#b3261e;color:#9b1c1c;display:none}
      #tutorAuthModal{position:fixed;inset:0;z-index:10001;display:none;place-items:center;background:#0008;padding:16px}
      #tutorAuthModal.open{display:grid}.tutor-auth-card{width:min(410px,100%);background:#fff;border-radius:16px;padding:22px;box-shadow:0 18px 60px #0005}
      .tutor-auth-card h2{margin:0 0 8px;color:#2d6d34;font-size:22px}.tutor-auth-card p{margin:0 0 16px;color:#555;line-height:1.45}
      .tutor-auth-card input{width:100%;padding:11px;border:1px solid #ccc;border-radius:9px;margin:0 0 10px;font:inherit}
      .tutor-auth-actions{display:flex;gap:8px;flex-wrap:wrap}.tutor-auth-actions button{flex:1;min-width:130px;padding:10px;border:0;border-radius:9px;cursor:pointer;font-weight:700}
      #tutorSignIn{background:#4caf50;color:#fff}.tutorSignUp{background:#e8f5e9;color:#2d6d34}#tutorSignOut{background:#f5f5f5;color:#555;display:none}
      .tutorAuthClose{float:right;border:0;background:none;font-size:24px;cursor:pointer;color:#777}.tutor-auth-message{min-height:22px;margin:12px 0 0;font-size:13px}
      .tutor-auth-message.ok{color:#2d6d34}.tutor-auth-message.error{color:#b3261e}
      #tutorInitialSyncModal{position:fixed;inset:0;z-index:10002;display:none;place-items:center;background:#0009;padding:16px}
      #tutorInitialSyncModal.open{display:grid}
      .tutor-initial-actions{display:grid;gap:9px}
      .tutor-initial-actions button{border:0;border-radius:9px;padding:12px;cursor:pointer;font-weight:700}
      #tutorUseCloud{background:#4caf50;color:#fff}
      #tutorMergeDevice{background:#e8f5e9;color:#245b2b}
      @media(max-width:700px){
        .app-tabs{flex-wrap:wrap}
        #tutorAuthBar{flex:0 0 100%;display:flex;justify-content:flex-end}
        #tutorCloudToggle{max-width:calc(100vw - 16px);font-size:12px;padding:8px 10px}
        #tutorCloudPanel{width:min(320px,calc(100vw - 16px))}
        #tutorCloudPanel{top:calc(100% + 4px);right:0}
        #view-calendar header{position:static}
      }
    `;
    document.head.appendChild(style);
    document.body.insertAdjacentHTML('beforeend', `
      <div id="tutorAuthBar" data-state="offline">
        <button id="tutorCloudToggle" type="button" aria-expanded="false" aria-controls="tutorCloudPanel" title="Открыть настройки аккаунта и синхронизации">
          <span class="tutor-cloud-icon">☁️</span><span class="tutor-cloud-dot"></span><span id="tutorCloudToggleText">Офлайн</span><span class="tutor-chevron">⌄</span>
        </button>
        <div id="tutorCloudPanel" role="dialog" aria-label="Аккаунт и синхронизация">
          <div id="tutorAccountStatus">Аккаунт: не выполнен вход</div>
          <div id="tutorSyncStatus" data-state="offline" role="status" aria-live="polite" title="Статус синхронизации"><span class="tutor-status-dot"></span><span id="tutorSyncStatusText">Статус: Офлайн</span></div>
          <div id="tutorSyncError" role="alert" hidden></div>
          <div class="tutor-menu-actions">
            <button id="tutorLogin" type="button">Войти</button>
            <button id="tutorCreate" type="button">Создать аккаунт</button>
            <button id="tutorLogout" type="button">Выйти</button>
          </div>
        </div>
      </div>
      <div id="tutorAuthModal" aria-hidden="true"><div class="tutor-auth-card">
        <button class="tutorAuthClose" id="tutorAuthClose" aria-label="Закрыть">×</button>
        <h2>☁️ Облачная синхронизация</h2>
        <p>Войдите или создайте аккаунт, чтобы синхронизировать все данные приложения.</p>
        <input id="tutorAuthEmail" type="email" autocomplete="email" placeholder="Email">
        <input id="tutorAuthPassword" type="password" autocomplete="current-password" placeholder="Пароль (минимум 6 символов)">
        <div class="tutor-auth-actions"><button id="tutorSignIn">Войти</button><button class="tutorSignUp" id="tutorSignUp">Создать аккаунт</button><button id="tutorSignOut">Выйти</button></div>
        <div id="tutorAuthMessage" class="tutor-auth-message" aria-live="polite"></div>
      </div></div>
      <div id="tutorInitialSyncModal" role="dialog" aria-modal="true" aria-label="Выберите данные для синхронизации"><div class="tutor-auth-card">
        <h2>☁️ Какие данные сохранить?</h2>
        <p id="tutorInitialSyncDescription"></p>
        <div class="tutor-initial-actions">
          <button id="tutorUseCloud" type="button">Использовать данные из облака</button>
          <button id="tutorMergeDevice" type="button">Объединить с данными устройства</button>
        </div>
      </div></div>
    `);
    document.querySelector('.app-tabs')?.appendChild(document.getElementById('tutorAuthBar'));
    const modal = document.getElementById('tutorAuthModal');
    const bar = document.getElementById('tutorAuthBar');
    const cloudToggle = document.getElementById('tutorCloudToggle');
    const closePanel = () => {
      bar.classList.remove('open');
      cloudToggle.setAttribute('aria-expanded', 'false');
    };
    const openModal = () => { closePanel(); if (!user) setMessage('', ''); modal.classList.add('open'); };
    cloudToggle.onclick = () => {
      const open = !bar.classList.contains('open');
      bar.classList.toggle('open', open);
      cloudToggle.setAttribute('aria-expanded', String(open));
    };
    document.getElementById('tutorLogin').onclick = openModal;
    document.getElementById('tutorCreate').onclick = openModal;
    document.getElementById('tutorLogout').onclick = signOut;
    document.getElementById('tutorAuthClose').onclick = () => modal.classList.remove('open');
    modal.onclick = event => { if (event.target === modal) modal.classList.remove('open'); };
    document.addEventListener('click', event => {
      if (!bar.contains(event.target)) closePanel();
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') { closePanel(); modal.classList.remove('open'); }
    });
    document.getElementById('tutorSignIn').onclick = signIn;
    document.getElementById('tutorSignUp').onclick = signUp;
    document.getElementById('tutorSignOut').onclick = signOut;
  }

  function updateAuthUI() {
    const userStatus = document.getElementById('tutorAccountStatus');
    if (!userStatus) return;
    const login = document.getElementById('tutorLogin');
    const create = document.getElementById('tutorCreate');
    const logout = document.getElementById('tutorLogout');
    const signInButton = document.getElementById('tutorSignIn');
    const signUpButton = document.getElementById('tutorSignUp');
    const signOutButton = document.getElementById('tutorSignOut');
    if (user) {
      userStatus.textContent = 'Аккаунт: ' + (user.email || 'выполнен вход');
      login.style.display = 'none';
      create.style.display = 'none';
      logout.style.display = 'inline-flex';
      signInButton.style.display = 'none';
      signUpButton.style.display = 'none';
      signOutButton.style.display = 'block';
    } else {
      userStatus.textContent = 'Аккаунт: не выполнен вход';
      login.style.display = 'inline-flex';
      create.style.display = 'inline-flex';
      logout.style.display = 'none';
      signInButton.style.display = '';
      signUpButton.style.display = '';
      signOutButton.style.display = 'none';
      setSyncStatus('offline');
      // Не показываем старую ошибку предыдущей сессии в новом окне входа.
      setMessage('', '');
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
    finally {
      setBusy(false);
      setMessage('', '');
      document.getElementById('tutorAuthModal').classList.remove('open');
    }
  }

  async function uploadSnapshot(snapshot) {
    if (!user || applyingRemote) return;
    if (!navigator.onLine) {
      setSyncStatus('offline');
      return;
    }
    setSyncStatus('syncing');
    let serialized = snapshotSignature(snapshot);
    if (serialized === lastUploaded) {
      saveSyncBase(snapshot);
      setSyncStatus('synced');
      return;
    }
    // Never let a fresh browser with an empty localStorage erase an existing
    // cloud snapshot during auth/session races. A deliberate deletion from a
    // previously populated session still uploads because lastUploaded is set.
    if (!hasAppContent(snapshot) && !lastUploaded) {
      setSyncStatus('synced');
      return;
    }
    const activeUserId = user.id;
    for (let attempt = 0; attempt < 3; attempt++) {
      const oldVersion = remoteUpdatedAt;
      const nextVersion = new Date(Math.max(Date.now(), Date.parse(oldVersion || '') + 1 || 0)).toISOString();
      const row = { user_id: activeUserId, id: SNAPSHOT_ID, data: snapshot, updated_at: nextVersion };
      const result = oldVersion
        ? await client.from(DATA_TABLE).update({ data: snapshot, updated_at: nextVersion })
          .eq('user_id', activeUserId).eq('id', SNAPSHOT_ID).eq('updated_at', oldVersion)
          .select('updated_at')
        : await client.from(DATA_TABLE).insert(row).select('updated_at');
      if (user?.id !== activeUserId) return;
      if (result.error && result.error.code !== '23505') throw result.error;
      if (result.data?.length) {
        remoteUpdatedAt = result.data[0].updated_at;
        lastUploaded = serialized;
        saveSyncBase(snapshot);
        setSyncStatus('synced');
        return;
      }

      // Another device wrote since our last read. Reconcile against the
      // common base and retry with the new database version.
      const current = await client.from(DATA_TABLE).select('data,updated_at')
        .eq('user_id', activeUserId).eq('id', SNAPSHOT_ID).maybeSingle();
      if (current.error) throw current.error;
      if (user?.id !== activeUserId) return;
      const remote = current.data?.data || {};
      remoteUpdatedAt = current.data?.updated_at || null;
      lastUploaded = remoteUpdatedAt ? snapshotSignature(remote) : '';
      snapshot = mergeCanonical(readSyncBase() || {}, snapshot, remote);
      serialized = snapshotSignature(snapshot);
      applyingRemote = true;
      try { writeSnapshot(snapshot); }
      finally { applyingRemote = false; }
      notifyApp();
      if (serialized === lastUploaded) {
        saveSyncBase(snapshot);
        setSyncStatus('synced');
        return;
      }
    }
    throw new Error('Одновременные изменения не удалось объединить. Повторите синхронизацию.');
  }

  async function loadRemote() {
    if (!navigator.onLine) throw new Error('Устройство офлайн');
    setSyncStatus('syncing');
    const activeUserId = user.id;
    const { data, error } = await client.from(DATA_TABLE).select('id,data,updated_at').eq('user_id', activeUserId);
    if (error) throw error;
    if (user?.id !== activeUserId) return;
    const legacyRows = {};
    let remoteSnapshot = {};
    for (const row of data || []) {
      if (row.id === SNAPSHOT_ID) {
        remoteSnapshot = row.data || {};
        remoteUpdatedAt = row.updated_at;
      }
      if (row.id === 'calendar') legacyRows.calendar = row.data || [];
      if (row.id === 'finance') legacyRows.finance = row.data || {};
    }
    let localSnapshot = snapshotLocal();
    const owner = localStorage.getItem(SYNC_OWNER_KEY);
    if (owner && owner !== activeUserId) {
      // A browser may still contain another account's cached data after logout.
      // Never import it into the newly signed-in account.
      localStorage.removeItem(SYNC_BASE_KEY);
      localSnapshot = {};
    }
    if (!owner && readSyncBase() &&
        snapshotSignature(readSyncBase()) !== snapshotSignature(remoteSnapshot) &&
        snapshotSignature(readSyncBase()) !== snapshotSignature(localSnapshot)) {
      // An older unscoped base cannot safely identify which account it belongs to.
      localStorage.removeItem(SYNC_BASE_KEY);
    }
    localStorage.setItem(SYNC_OWNER_KEY, activeUserId);
    const hasCanonicalRemote = (data || []).some(row => row.id === SNAPSHOT_ID);
    const crossAccount = !!owner && owner !== activeUserId;
    let importLocal = false;
    if (hasCanonicalRemote && needsInitialChoice(remoteSnapshot, localSnapshot, readSyncBase(), !crossAccount)) {
      importLocal = await chooseInitialSource(remoteSnapshot, localSnapshot);
      if (user?.id !== activeUserId) return;
    }
    const merged = crossAccount && !hasCanonicalRemote
      ? mergeSnapshots({}, {}, legacyRows)
      : importLocal
        ? mergeSnapshots(remoteSnapshot, localSnapshot, {})
        : resolveSnapshot(remoteSnapshot, localSnapshot, legacyRows);
    lastUploaded = hasCanonicalRemote ? snapshotSignature(remoteSnapshot) : '';
    applyingRemote = true;
    try { writeSnapshot(merged); }
    finally { applyingRemote = false; }
    notifyApp();
    await uploadSnapshot(merged);
  }

  function scheduleSync() {
    if (!user || applyingRemote) return;
    if (!navigator.onLine) { setSyncStatus('offline'); return; }
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      if (syncInFlight || loadingUserId) {
        syncQueued = true;
        return;
      }
      syncInFlight = true;
      uploadSnapshot(snapshotLocal())
        .catch(error => {
          if (navigator.onLine) setSyncError(error);
          else setSyncStatus('offline');
          console.warn('Tutor cloud sync failed:', error?.message || error);
        })
        .finally(() => {
          syncInFlight = false;
          if (syncQueued) {
            syncQueued = false;
            scheduleSync();
          }
        });
    }, 700);
  }

  function setupRealtime() {
    if (channel) client.removeChannel(channel);
    const activeUserId = user.id;
    let subscribedOnce = false;
    setSyncStatus('syncing');
    channel = client.channel('tutor-user-data-' + activeUserId)
      .on('postgres_changes', { event: '*', schema: 'public', table: DATA_TABLE, filter: 'user_id=eq.' + activeUserId },
        payload => {
          if (user?.id !== activeUserId) return;
          if (payload.new?.id !== SNAPSHOT_ID || !payload.new?.data) return;
          const incoming = payload.new.data;
          const incomingSignature = snapshotSignature(incoming);
          const incomingVersion = payload.new.updated_at;
          if (remoteUpdatedAt && incomingVersion &&
              Date.parse(incomingVersion) < Date.parse(remoteUpdatedAt)) return;
          remoteUpdatedAt = incomingVersion || remoteUpdatedAt;
          if (incomingSignature === lastUploaded) return;
          const merged = resolveSnapshot(incoming, snapshotLocal(), {});
          applyingRemote = true;
          try { writeSnapshot(merged); }
          finally { applyingRemote = false; }
          lastUploaded = incomingSignature;
          if (snapshotSignature(merged) === incomingSignature) saveSyncBase(merged);
          notifyApp();
          if (snapshotSignature(merged) !== incomingSignature) scheduleSync();
          else setSyncStatus('synced');
        })
      .subscribe(status => {
        if (user?.id !== activeUserId) return;
        if (status === 'SUBSCRIBED') {
          if (!subscribedOnce) {
            subscribedOnce = true;
            setSyncStatus('synced');
            return;
          }
          // A reconnect can miss updates made while the socket was down.
          if (loadingUserId) return;
          loadingUserId = activeUserId;
          loadRemote()
            .catch(error => setSyncError(error))
            .finally(() => {
              if (loadingUserId === activeUserId) loadingUserId = null;
              if (syncQueued) { syncQueued = false; scheduleSync(); }
            });
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          setSyncError(new Error('Нет соединения для обновлений в реальном времени. Проверьте сеть; приложение повторит подключение.'));
        }
      });
  }

  async function onSession(session) {
    const nextUser = session?.user || null;
    if (nextUser && user?.id === nextUser.id && (channel || loadingUserId === nextUser.id)) {
      user = nextUser;
      updateAuthUI();
      return;
    }
    if (user?.id !== nextUser?.id) {
      lastUploaded = '';
      remoteUpdatedAt = null;
    }
    user = nextUser;
    syncState = user ? 'syncing' : 'offline';
    updateAuthUI();
    if (!user) {
      if (channel) { client.removeChannel(channel); channel = null; }
      loadingUserId = null;
      lastUploaded = '';
      remoteUpdatedAt = null;
      return;
    }
    const activeUserId = user.id;
    loadingUserId = activeUserId;
    try {
      await loadRemote();
      if (user?.id !== activeUserId) return;
      setupRealtime();
      setMessage('Облако синхронизировано.', 'ok');
    } catch (error) {
      if (user?.id !== activeUserId) return;
      if (navigator.onLine) setSyncError(error);
      else setSyncStatus('offline');
      console.warn('Tutor cloud initialization failed:', error);
      setMessage(navigator.onLine
        ? 'Синхронизация не удалась: ' + describeSyncError(error)
        : 'Нет сети. Данные сохранены на устройстве; синхронизация возобновится после подключения.', 'error');
    } finally {
      if (loadingUserId === activeUserId) loadingUserId = null;
      if (user?.id === activeUserId && syncQueued) {
        syncQueued = false;
        scheduleSync();
      }
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
    window.addEventListener('offline', () => { setSyncStatus('offline'); });
    window.addEventListener('online', () => { if (user) scheduleSync(); });
    if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY || SUPABASE_URL.includes('__SUPABASE')) {
      setMessage('Supabase ещё не подключён.', 'error');
      return;
    }
    try {
      const module = await import(CDN);
      client = module.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
      client.auth.onAuthStateChange((event, session) => {
        if (event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') return;
        void onSession(session);
      });
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
