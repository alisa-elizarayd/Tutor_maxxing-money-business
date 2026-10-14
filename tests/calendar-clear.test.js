const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function runSection(startText, endText, context) {
  const start = html.indexOf(startText);
  const end = html.indexOf(endText, start);
  assert.ok(start >= 0 && end > start, 'expected calendar bridge code is present');
  vm.runInNewContext(html.slice(start, end), context);
}

test('clear markers hide existing paid lessons without deleting finance records', () => {
  const student = {
    id: 'student', name: 'Тест', days: ['Чт'], time: '18:30', rate: 1200,
    payments: [{ id: 'payment', lessons: 1 }],
    lessons: [{ id: 'finance-lesson', paymentId: 'payment', date: '2026-10-22', time: '18:30', status: 'planned' }]
  };
  const financeWindow = {};
  const financeContext = {
    window: financeWindow, state: { students: [student] }, syncingFromCalendar: false,
    save: () => {}, Set, Map
  };
  runSection('  window.captureFinanceCalendarVisibility = function(){', '\n  function save(){', financeContext);
  const before = financeWindow.captureFinanceCalendarVisibility();
  financeWindow.hideFinanceLessonsFromCalendar();

  assert.deepEqual(Array.from(student.calendarClearedLessonIds), ['finance-lesson']);
  assert.deepEqual(Array.from(student.calendarClearedPaymentIds), ['payment']);
  assert.equal(student.payments.length, 1);
  assert.equal(student.lessons.length, 1);

  let savedCalendar = '';
  const calendarContext = {
    syncingToFinance: false, syncingFromFinance: false, lessons: [],
    localStorage: { setItem: (_key, value) => { savedCalendar = value; } },
    renderCalendar: () => {},
    financeSourceCalendarLesson: () => null,
    subscriptionColor: () => '#4CAF50',
    syncId: () => 'new-calendar-id'
  };
  runSection('  function syncFinanceToCalendar(financeStudents){', '\n  window.syncFinanceToCalendar = syncFinanceToCalendar;', calendarContext);
  calendarContext.syncFinanceToCalendar([student]);
  assert.equal(savedCalendar, '[]');

  financeWindow.restoreFinanceCalendarVisibility(before);
  assert.deepEqual(Array.from(student.calendarClearedLessonIds), []);
  assert.deepEqual(Array.from(student.calendarClearedPaymentIds), []);
});

test('a manually rebuilt card may reconnect to an old paid lesson', () => {
  const student = {
    id: 'student', name: 'Тест', time: '18:30', rate: 1200,
    calendarClearedLessonIds: ['finance-lesson'],
    calendarClearedPaymentIds: ['payment'],
    payments: [{ id: 'payment' }],
    lessons: [{ id: 'finance-lesson', paymentId: 'payment', date: '2026-10-22', time: '18:30', status: 'planned' }]
  };
  const rebuilt = { id: 'rebuilt', name: 'Тест', date: '2026-10-22', time: '18:30', color: '#4CAF50', calendarOnly: true };
  const context = {
    syncingToFinance: false, syncingFromFinance: false, lessons: [rebuilt],
    localStorage: { setItem: () => {} }, renderCalendar: () => {},
    financeSourceCalendarLesson: () => null,
    subscriptionColor: () => '#4CAF50', syncId: () => 'unexpected'
  };
  runSection('  function syncFinanceToCalendar(financeStudents){', '\n  window.syncFinanceToCalendar = syncFinanceToCalendar;', context);
  context.syncFinanceToCalendar([student]);

  assert.equal(context.lessons.length, 1);
  assert.equal(rebuilt.financeLessonId, 'finance-lesson');
  assert.equal(rebuilt.financeStudentId, 'student');
  assert.equal(rebuilt.calendarOnly, undefined);
});

test('canceling clear-all changes nothing; confirming clears every month and supports undo', () => {
  const original = [
    { id: 'october', date: '2026-10-15' },
    { id: 'november', date: '2026-11-05' }
  ];
  const undoStack = [];
  const selection = new Set(['october']);
  const visibility = [{ id: 'student', lessonIds: [], paymentIds: [] }];
  let approved = false;
  let hidden = 0;
  let restored = null;
  let saved = 0;
  const context = {
    lessons: [...original], selectedLessonIds: selection, selectionMode: true,
    confirm: () => approved,
    window: {
      captureFinanceCalendarVisibility: () => visibility,
      hideFinanceLessonsFromCalendar: () => { hidden++; },
      restoreFinanceCalendarVisibility: snapshot => { restored = snapshot; }
    },
    pushUndo: (label, extra) => undoStack.push({ lessons: structuredClone(context.lessons), label, time: Date.now(), ...extra }),
    saveToStorage: () => { saved++; },
    updateSelectionToolbar: () => {}, renderCalendar: () => {}, updateUndoBtn: () => {},
    undoStack, alert: () => {}
  };
  runSection('  function deleteAllLessons(){', '\n  // === РЕНДЕР КАЛЕНДАРЯ ===', context);
  runSection('  function performUndo(){', '\n  const EMOJI_OPTIONS = [', context);

  context.deleteAllLessons();
  assert.equal(context.lessons.length, 2);
  assert.equal(hidden, 0);
  assert.equal(saved, 0);

  approved = true;
  context.deleteAllLessons();
  assert.equal(context.lessons.length, 0);
  assert.equal(selection.size, 0);
  assert.equal(context.selectionMode, false);
  assert.equal(hidden, 1);
  assert.equal(saved, 1);
  assert.equal(undoStack.length, 1);

  context.performUndo();
  assert.deepEqual(context.lessons.map(lesson => lesson.id), ['october', 'november']);
  assert.equal(restored, visibility);
  assert.equal(saved, 2);
});
