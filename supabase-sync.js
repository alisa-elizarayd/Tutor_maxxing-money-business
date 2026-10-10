/* Tutor Maxxing cloud auth + sync.
 * Uses only a Supabase publishable key in the browser.
 * Data is scoped by auth.uid() through database RLS.
 */
(() => {
  'use strict';

  const CONFIG = window.TUTOR_SUPABASE_CONFIG || {};
  const SUPABASE_URL = CONFIG.url || '';
  const SUPABASE_PUBLISHABLE_KEY = CONFIG.publishableKey || '';
  const CDN = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/+esm';
  const DATA_TABLE = 'user_data';
  const SYNC_IDS = {
    calendar: 'tutorLessonsPro',
    finance: 'tutor_mvp_state_v5'
  };

  let client = null;
  let user = null;
  let channel = null;
  let syncTimer = null;
  let lastUploaded = new Map();
  let applyingRemote = false;

  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  }[ch]));

  function readLocal(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
  }

  function writeLocal(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  function notifyApp(id) {
    if (id === 'finance') {
      window.dispatchEvent(new Event('finance-state-changed'));
    } else {
      window.dispatchEvent(new Event('calendar-state-changed'));
    }
  }

  function setMessage(text, type = '') {
    const el = document.getElementById('tutorAuthMessage');
    if (el) {
      el.textContent = text;
      el.className = 'tutor-auth-message ' + type;
    }
  }

  function setBusy(value) {
    document.querySelectorAll('#tutorAuthModal button').forEach(button => {
      button.disabled = value;
    });
  }

  function ensureAuthUI() {
    if (document.getElementById('tutorAuthModal')) return;
    const style = document.createElement('style');
    style.textContent = `
      #tutorAuthBar{position:fixed;top:12px;right:14px;z-index:10000;display:flex;gap:8px;align-items:center}
      #tutorAuthOpen{border:1px solid #4caf50;background:#fff;color:#2d6d34;border-radius:10px;padding:8px 12px;cursor:pointer;font-weight:700;box-shadow:0 2px 10px #0002}
      #tutorAuthStatus{font-size:12px;color:#2d6d34;background:#fff;border-radius:9px;padding:7px 9px;box-shadow:0 2px 10px #0002;max-width:230px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      #tutorAuthModal{position:fixed;inset:0;z-index:10001;display:none;place-items:center;background:#0008;padding:16px}
      #tutorAuthModal.open{display:grid}
      .tutor-auth-card{width:min(410px,100%);background:#fff;border-radius:16px;padding:22px;box-shadow:0 18px 60px #0005}
      .tutor-auth-card h2{margin:0 0 8px;color:#2d6d34;font-size:22px}
      .tutor-auth-card p{margin:0 0 16px;color:#555;line-height:1.45}
      .tutor-auth-card input{width:100%;padding:11px;border:1px solid #ccc;border-radius:9px;margin:0 0 10px;font:inherit}
      .tutor-auth-actions{display:flex;gap:8px;flex-wrap:wrap}
      .tutor-auth-actions button{flex:1;min-width:130px;padding:10px;border:0;border-radius:9px;cursor:pointer;font-weight:700}
      #tutorSignIn{background:#4caf50;color:#fff}.tutorSignUp{background:#e8f5e9;color:#2d6d34}
      #tutorSignOut{background:#f5f5f5;color:#555;display:none}.tutorAuthClose{float:right;border:0;background:none;font-size:24px;cursor:pointer;color:#777}
      .tutor-auth-message{min-height:22px;margin:12px 0 0;font-size:13px}.tutor-auth-message.ok{color:#2d6d34}.tutor-auth-message.error{color:#b3261e}
      @media(max-width:600px){#tutorAuthBar{top:8px;right:8px}#tutorAuthStatus{display:none}}
    `;
    document.head.appendChild(style);
    document.body.insertAdjacentHTML('beforeend', `
      <div id="tutorAuthBar"><span id="tutorAuthStatus">☁️ Локальный режим</span><button id="tutorAuthOpen">☁️ Войти</button></div>
      <div id="tutorAuthModal" aria-hidden="true">
        <div class="tutor-auth-card">
          <button class="tutorAuthClose" id="tutorAuthClose" aria-label="Закрыть">×</button>
          <h2>☁️ Облачная синхронизация</h2>
          <p>Создайте аккаунт, подтвердите email и синхронизируйте календарь и финансы на всех устройствах.</p>
          <input id="tutorAuthEmail" type="email" autocomplete="email" placeholder="Email">
          <input id="tutorAuthPassword" type="password" autocomplete="current-password" placeholder="Пароль (минимум 6 символов)">
          <div class="tutor-auth-actions">
            <button id="tutorSignIn">Войти</button>
            <button class="tutorSignUp" id="tutorSignUp">Создать аккаунт</button>
            <button id="tutorSignOut">Выйти</button>
          </div>
          <div id="tutorAuthMessage" class="tutor-auth-message" aria-live="polite"></div>
        </div>
      </div>
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
    const signIn = document.getElementById('tutorSignIn');
    const signUp = document.getElementById('tutorSignUp');
    const signOut = document.getElementById('tutorSignOut');
    if (!status) return;
    if (user) {
      status.textContent = '☁️ ' + (user.email || 'Аккаунт');
      open.textContent = '☁️ Аккаунт';
      signIn.style.display = 'none'; signUp.style.display = 'none'; signOut.style.display = 'block';
    } else {
      status.textContent = '☁️ Локальный режим';
      open.textContent = '☁️ Войти';
      signIn.style.display = ''; signUp.style.display = ''; signOut.style.display = 'none';
    }
  }

  async function signIn() {
    const email = document.getElementById('tutorAuthEmail').value.trim();
    const password = document.getElementById('tutorAuthPassword').value;
    if (!email || !password) return setMessage('Введите email и пароль.', 'error');
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
    setBusy(true); setMessage('Создаём аккаунт…');
    try {
      const { data, error } = await client.auth.signUp({
        email, password,
        options: { emailRedirectTo: window.location.href }
      });
      if (error) throw error;
      setMessage(data.session
        ? 'Аккаунт создан. Синхронизация запущена.'
        : 'Аккаунт создан. Проверьте почту и подтвердите email, затем войдите.', 'ok');
    } catch (error) { setMessage(error.message || 'Не удалось создать аккаунт.', 'error'); }
    finally { setBusy(false); }
  }

  async function signOut() {
    setBusy(true);
    try { await client.auth.signOut(); }
    finally { setBusy(false); document.getElementById('tutorAuthModal').classList.remove('open'); }
  }

  async function loadRemote() {
    const { data, error } = await client.from(DATA_TABLE).select('id,data,updated_at').eq('user_id', user.id);
    if (error) throw error;
    const byId = new Map((data || []).map(row => [row.id, row]));
    for (const [id, key] of Object.entries(SYNC_IDS)) {
      const local = readLocal(key);
      const remote = byId.get(id);
      if (remote?.data != null) {
        applyingRemote = true;
        writeLocal(key, remote.data);
        applyingRemote = false;
        notifyApp(id);
        lastUploaded.set(id, JSON.stringify(remote.data));
      } else if (local != null) {
        await uploadOne(id, local);
      }
    }
  }

  async function uploadOne(id, value) {
    if (!user || applyingRemote || value == null) return;
    const serialized = JSON.stringify(value);
    if (lastUploaded.get(id) === serialized) return;
    const { error } = await client.from(DATA_TABLE).upsert(
      { user_id: user.id, id, data: value, updated_at: new Date().toISOString() },
      { onConflict: 'user_id,id' }
    );
    if (error) throw error;
    lastUploaded.set(id, serialized);
  }

  async function uploadLocalChanges() {
    if (!user || applyingRemote) return;
    for (const [id, key] of Object.entries(SYNC_IDS)) await uploadOne(id, readLocal(key));
  }

  function scheduleSync() {
    if (!user || applyingRemote) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => uploadLocalChanges().catch(error => console.warn('Tutor cloud sync failed:', error)), 700);
  }

  function setupRealtime() {
    if (channel) client.removeChannel(channel);
    channel = client.channel('tutor-user-data-' + user.id)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: DATA_TABLE, filter: 'user_id=eq.' + user.id },
        payload => {
          const id = payload.new?.id;
          const key = SYNC_IDS[id];
          if (!key || JSON.stringify(payload.new.data) === lastUploaded.get(id)) return;
          applyingRemote = true;
          writeLocal(key, payload.new.data);
          applyingRemote = false;
          lastUploaded.set(id, JSON.stringify(payload.new.data));
          notifyApp(id);
        })
      .subscribe();
  }

  async function onSession(session) {
    user = session?.user || null;
    updateAuthUI();
    if (!user) {
      if (channel) { client.removeChannel(channel); channel = null; }
      lastUploaded.clear();
      return;
    }
    try {
      await loadRemote();
      setupRealtime();
      await uploadLocalChanges();
      setMessage('Облако синхронизировано.', 'ok');
    } catch (error) {
      console.warn('Tutor cloud initialization failed:', error);
      setMessage('Облако недоступно: ' + (error.message || 'ошибка синхронизации'), 'error');
    }
  }

  function startLocalWatch() {
    let previous = new Map();
    setInterval(() => {
      if (!user || applyingRemote) return;
      for (const [id, key] of Object.entries(SYNC_IDS)) {
        const raw = localStorage.getItem(key) || '';
        if (previous.get(id) !== raw) { previous.set(id, raw); scheduleSync(); }
      }
    }, 1500);
    window.addEventListener('finance-state-changed', scheduleSync);
    window.addEventListener('calendar-state-changed', scheduleSync);
  }

  async function init() {
    ensureAuthUI();
    updateAuthUI();
    if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY || SUPABASE_URL.includes('__SUPABASE')) {
      setMessage('Supabase ещё не подключён: добавьте URL и publishable key проекта.', 'error');
      return;
    }
    try {
      const module = await import(CDN);
      client = module.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
      });
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
