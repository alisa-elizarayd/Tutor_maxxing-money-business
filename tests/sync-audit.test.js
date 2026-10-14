const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadSync() {
  const values = new Map();
  const localStorage = {
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); }
  };
  const window = { TUTOR_SUPABASE_CONFIG: {}, dispatchEvent() {} };
  const document = { readyState: 'loading', addEventListener() {}, getElementById() { return null; } };
  const source = fs.readFileSync(path.join(__dirname, '..', 'supabase-sync.js'), 'utf8')
    .replace('window.tutorCloud = { init, scheduleSync };',
      'window.tutorCloud = { init, scheduleSync, _test: { resolveSnapshot, mergeSnapshots, needsInitialChoice, snapshotLocal, snapshotSignature, writeSnapshot, loadRemote, describeSyncError, setSession: (nextClient, nextUser) => { client = nextClient; user = nextUser; } } };');
  vm.runInNewContext(source, { window, document, localStorage, Event, navigator: { onLine: true } });
  return { ...window.tutorCloud._test, localStorage };
}

test('deletions stay deleted when another device adds different records', () => {
  const sync = loadSync();
  const base = {
    tutorLessonsPro: [{ id: 'l1' }, { id: 'l2' }],
    tutor_mvp_state_v5: { students: [{ id: 's1' }, { id: 's2' }], notes: [] }
  };
  sync.localStorage.setItem('tutorSyncBase', JSON.stringify(base));
  const local = {
    tutorLessonsPro: [{ id: 'l2' }],
    tutor_mvp_state_v5: { students: [{ id: 's2' }], notes: [] }
  };
  const remote = {
    tutorLessonsPro: [{ id: 'l1' }, { id: 'l2' }, { id: 'l3' }],
    tutor_mvp_state_v5: { students: [{ id: 's1' }, { id: 's2' }, { id: 's3' }], notes: [] }
  };
  const result = sync.resolveSnapshot(remote, local, {});
  assert.deepEqual(Array.from(result.tutorLessonsPro, lesson => lesson.id), ['l2', 'l3']);
  assert.deepEqual(Array.from(result.tutor_mvp_state_v5.students, student => student.id), ['s2', 's3']);
});

test('deleting a finance student also removes its linked calendar lessons', () => {
  const sync = loadSync();
  const base = {
    tutorLessonsPro: [{ id: 'linked', financeStudentId: 'student-1' }],
    tutor_mvp_state_v5: { students: [{ id: 'student-1' }], notes: [] }
  };
  sync.localStorage.setItem('tutorSyncBase', JSON.stringify(base));
  const local = { ...base, tutor_mvp_state_v5: { students: [], notes: [] } };
  const result = sync.resolveSnapshot(base, local, {});
  assert.deepEqual(Array.from(result.tutorLessonsPro), []);
  assert.deepEqual(Array.from(result.tutor_mvp_state_v5.students), []);
});

test('independent calendar, finance, notes and setting edits all survive reconciliation', () => {
  const sync = loadSync();
  const base = {
    tutorLessonsPro: [{ id: 'lesson-1' }],
    tutor_mvp_state_v5: { students: [{ id: 'student-1', rate: 1000 }], notes: [{ id: 'note-1' }] },
    tutorTheme: 'light'
  };
  sync.localStorage.setItem('tutorSyncBase', JSON.stringify(base));
  const local = {
    ...base,
    tutor_mvp_state_v5: { ...base.tutor_mvp_state_v5, notes: [{ id: 'note-1' }, { id: 'note-2' }] },
    tutorTheme: 'dark'
  };
  const remote = {
    ...base,
    tutorLessonsPro: [{ id: 'lesson-1' }, { id: 'lesson-2' }],
    tutor_mvp_state_v5: { ...base.tutor_mvp_state_v5, students: [{ id: 'student-1', rate: 1500 }] }
  };
  const result = sync.resolveSnapshot(remote, local, {});
  assert.equal(result.tutorLessonsPro.length, 2);
  assert.equal(result.tutor_mvp_state_v5.students[0].rate, 1500);
  assert.equal(result.tutor_mvp_state_v5.notes.length, 2);
  assert.equal(result.tutorTheme, 'dark');
});

test('an empty canonical snapshot cannot resurrect legacy finance data', () => {
  const sync = loadSync();
  const base = { tutorLessonsPro: [{ id: 'l1' }], tutor_mvp_state_v5: { students: [{ id: 's1' }], notes: [] } };
  sync.localStorage.setItem('tutorSyncBase', JSON.stringify(base));
  const local = { tutorLessonsPro: [{ id: 'l1' }, { id: 'l2' }], tutor_mvp_state_v5: { students: [{ id: 's1' }], notes: [] } };
  const remote = { tutorLessonsPro: [], tutor_mvp_state_v5: { students: [], notes: [] } };
  const legacy = { calendar: [{ id: 'l1' }], finance: { students: [{ id: 's1' }, { id: 's2' }] } };
  const result = sync.resolveSnapshot(remote, local, legacy);
  assert.deepEqual(Array.from(result.tutorLessonsPro, lesson => lesson.id), ['l2']);
  assert.equal(result.tutor_mvp_state_v5.students.length, 0);
});

test('remote deletion of a synced setting removes the stale local key', () => {
  const sync = loadSync();
  sync.localStorage.setItem('tutorTheme', '"dark"');
  sync.writeSnapshot({ tutorLessonsPro: [] });
  assert.equal(sync.localStorage.getItem('tutorTheme'), null);
});

test('background patterns sync while uploaded photos remain local', () => {
  const sync = loadSync();
  sync.localStorage.setItem('tutorBg', 'forest');
  assert.equal(sync.snapshotLocal().tutorBg, 'forest');
  sync.localStorage.setItem('tutorSyncBase', JSON.stringify({ tutorBg: 'forest' }));
  sync.localStorage.setItem('tutorBg', 'data:image/jpeg;base64,private-photo');
  assert.equal(sync.snapshotLocal().tutorBg, 'forest');
  sync.writeSnapshot({ tutorBg: 'sky' });
  assert.match(sync.localStorage.getItem('tutorBg'), /^data:image/);
  sync.writeSnapshot({});
  assert.match(sync.localStorage.getItem('tutorBg'), /^data:image/);
});

test('object key order does not count as a cloud change', () => {
  const sync = loadSync();
  assert.equal(sync.snapshotSignature({ a: 1, b: { x: 1, y: 2 } }),
    sync.snapshotSignature({ b: { y: 2, x: 1 }, a: 1 }));
});

test('browser storage quota error is not misreported as a Supabase quota', () => {
  const sync = loadSync();
  const message = sync.describeSyncError({ name: 'QuotaExceededError', message: 'The quota has been exceeded.' });
  assert.match(message, /Память браузера заполнена/);
});

test('first login with different local records requires an explicit merge choice', () => {
  const sync = loadSync();
  const remote = { tutorLessonsPro: [{ id: 'cloud' }], tutor_mvp_state_v5: { students: [], notes: [] } };
  const local = { tutorLessonsPro: [{ id: 'device' }], tutor_mvp_state_v5: { students: [], notes: [] } };
  assert.equal(sync.needsInitialChoice(remote, local, null, true), true);
  assert.equal(sync.needsInitialChoice(remote, local, null, false), false);
  assert.equal(sync.needsInitialChoice(remote, local, remote, true), false);
  assert.deepEqual(Array.from(sync.mergeSnapshots(remote, local, {}).tutorLessonsPro, lesson => lesson.id),
    ['device', 'cloud']);
});

test('logging into another account never imports the previous account cache', async () => {
  const sync = loadSync();
  sync.localStorage.setItem('tutorSyncOwner', 'old-user');
  sync.localStorage.setItem('tutorLessonsPro', JSON.stringify([{ id: 'private-lesson' }]));
  sync.localStorage.setItem('tutor_mvp_state_v5', JSON.stringify({ students: [{ id: 'private-student' }] }));
  const cloud = { tutorLessonsPro: [], tutor_mvp_state_v5: { students: [], notes: [] } };
  const client = { from() { return { select() { return this; }, eq() { return Promise.resolve({ data: [
    { id: 'app_state', data: cloud, updated_at: '2026-10-13T00:00:00.000Z' }
  ], error: null }); } }; } };
  sync.setSession(client, { id: 'new-user' });
  await sync.loadRemote();
  assert.equal(sync.localStorage.getItem('tutorSyncOwner'), 'new-user');
  assert.deepEqual(JSON.parse(sync.localStorage.getItem('tutorLessonsPro')), []);
  assert.deepEqual(JSON.parse(sync.localStorage.getItem('tutor_mvp_state_v5')).students, []);
});

test('a concurrent cloud update is re-read before uploading local changes', async () => {
  const sync = loadSync();
  const base = { tutorLessonsPro: [{ id: 'a' }], tutor_mvp_state_v5: { students: [], notes: [] } };
  sync.localStorage.setItem('tutorSyncOwner', 'test-user');
  sync.localStorage.setItem('tutorSyncBase', JSON.stringify(base));
  sync.localStorage.setItem('tutorLessonsPro', JSON.stringify([{ id: 'a' }, { id: 'b' }]));
  sync.localStorage.setItem('tutor_mvp_state_v5', JSON.stringify(base.tutor_mvp_state_v5));
  let updateAttempts = 0;
  let finalPayload = null;
  const initialRow = { id: 'app_state', data: base, updated_at: '2026-10-13T00:00:00.000Z' };
  const concurrentRow = { data: { ...base, tutorLessonsPro: [{ id: 'a' }, { id: 'c' }] },
    updated_at: '2026-10-13T00:00:01.000Z' };
  const client = { from() { return {
    select(columns) {
      if (columns === 'id,data,updated_at') return { eq() { return Promise.resolve({ data: [initialRow], error: null }); } };
      return { eq() { return { eq() { return { maybeSingle() { return Promise.resolve({ data: concurrentRow, error: null }); } }; } }; } };
    },
    update(payload) {
      finalPayload = payload;
      return { eq() { return { eq() { return { eq() { return {
        select() { updateAttempts++; return Promise.resolve(updateAttempts === 1
          ? { data: [], error: null }
          : { data: [{ updated_at: payload.updated_at }], error: null }); }
      }; } }; } }; } };
    }
  }; } };
  sync.setSession(client, { id: 'test-user' });
  await sync.loadRemote();
  assert.equal(updateAttempts, 2);
  assert.deepEqual(Array.from(finalPayload.data.tutorLessonsPro, item => item.id), ['a', 'b', 'c']);
});
