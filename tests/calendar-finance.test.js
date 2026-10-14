const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadCalendarFinanceSync(student) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const start = html.indexOf('  function syncCalendarToFinance(calendarLessons){');
  const end = html.indexOf('\n  window.syncCalendarToFinance = syncCalendarToFinance;', start);
  assert.ok(start !== -1 && end > start, 'calendar-to-finance sync function exists');

  const writes = new Map();
  let saves = 0;
  const context = {
    state: { students: [student] },
    syncingFromCalendar: false,
    normalizeStudentName: name => String(name).trim().toLowerCase(),
    localStorage: { setItem: (key, value) => writes.set(key, value) },
    save: () => { saves++; },
    uid: () => 'new-entitlement'
  };
  vm.runInNewContext(html.slice(start, end), context);
  return { sync: context.syncCalendarToFinance, writes, get saves() { return saves; } };
}

test('moving one paid lesson updates its date and time without changing recurring weekdays', () => {
  const financeLesson = {
    id: 'finance-lesson', date: '2026-10-27', time: '18:30',
    calendarLessonId: 'calendar-lesson', manualPaid: false
  };
  const student = {
    id: 'student', name: 'Тест', days: ['Вт'],
    scheduleSlots: [{ day: 'Вт', time: '18:30' }],
    scheduleStart: '2026-10-20', rate: 1200, time: '18:30',
    payments: [{ id: 'payment' }], lessons: [financeLesson]
  };
  const calendarLesson = {
    id: 'calendar-lesson', name: 'Тест', date: '2026-10-28',
    time: '19:15', rate: 1200, financeStudentId: 'student',
    financeLessonId: 'finance-lesson', manualPaid: false, seriesId: null
  };
  const harness = loadCalendarFinanceSync(student);

  harness.sync([calendarLesson]);

  assert.equal(financeLesson.date, '2026-10-28');
  assert.equal(financeLesson.time, '19:15');
  assert.deepEqual(Array.from(student.days), ['Вт']);
  assert.deepEqual(student.scheduleSlots.map(slot => slot.day), ['Вт']);
  assert.equal(student.scheduleStart, '2026-10-20');
  assert.equal(harness.saves, 1);
});
