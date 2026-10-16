const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function sourceBetween(start, end){
  const from = html.indexOf(start);
  const to = html.indexOf(end, from + start.length);
  assert.ok(from !== -1 && to > from, `${start} exists`);
  return html.slice(from, to);
}

function financeHarness(){
  let serial = 0;
  const context = {
    DAYS: ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'],
    uid: () => `generated-${++serial}`,
    todayISO: () => '2026-10-16',
    toISO: date => [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-'),
    window: {},
    state: { students: [] },
    pushUndo: () => {},
    save: () => {},
    render: () => {}
  };
  const source = [
    sourceBetween('  function ensureLessonEntitlements(student){', '  // One paid unit must always have one logical entitlement.'),
    sourceBetween('  function recalcLessons(student){', '  function pickMoveDate('),
    sourceBetween('  function removeMoveDescendants(student, parentId){', '  window.setLessonStatus = '),
    sourceBetween('  function getEntitlementGroups(student){', '  function normalizeStudentName(')
  ].join('\n');
  vm.createContext(context);
  vm.runInContext(source, context);
  vm.runInContext(sourceBetween('  window.setLessonStatus = async function', '  function getEntitlementGroups(student){'), context);
  return context;
}

function studentWithThreeFreeCancellations(){
  const dates = ['2026-09-27', '2026-09-29', '2026-10-01', '2026-10-04',
    '2026-10-06', '2026-10-08', '2026-10-11', '2026-10-13', '2026-10-15', '2026-10-18'];
  return {
    name: 'Тест', days: ['Вт', 'Чт', 'Вс'], time: '18:00',
    scheduleStart: '2026-09-26', balance: 4,
    payments: [{ id: 'payment-1', startDate: '2026-09-26', lessons: 10, amount: 17000 }],
    lessons: dates.map((date, index) => ({
      id: `lesson-${index + 1}`, date, time: '18:00', paymentId: 'payment-1',
      entitlementId: `entitlement-${index + 1}`,
      status: index < 6 ? 'done' : index < 9 ? 'free-cancel' : 'planned'
    }))
  };
}

test('repairs old free cancellations with one future lesson per cancellation, without spending balance', () => {
  const app = financeHarness();
  const student = studentWithThreeFreeCancellations();

  assert.equal(app.ensureFreeCancelReplacements(student), 3);
  assert.deepEqual(Array.from(student.lessons.filter(l => l.generatedByCancelId).map(l => l.date)),
    ['2026-10-20', '2026-10-22', '2026-10-25']);
  assert.equal(student.lessons.length, 13);
  assert.equal(app.ensureFreeCancelReplacements(student), 0);
  app.recalcLessons(student);
  const report = app.calcReport(student);
  assert.equal(report.total, 10);
  assert.equal(report.done, 6);
  assert.equal(report.planned, 4);
  assert.equal(report.freeCancel, 3);
  assert.equal(report.balance, 4);

  // Rehydrating the synced snapshot must not generate the same lessons again.
  const restored = JSON.parse(JSON.stringify(student));
  assert.equal(app.ensureFreeCancelReplacements(restored), 0);
  assert.equal(restored.lessons.length, 13);
});

test('free cancellation of a replacement extends its chain once more', () => {
  const app = financeHarness();
  const student = studentWithThreeFreeCancellations();
  app.ensureFreeCancelReplacements(student);
  const firstReplacement = student.lessons.find(l => l.generatedByCancelId === 'lesson-7');
  firstReplacement.status = 'free-cancel';

  assert.equal(app.ensureFreeCancelReplacements(student), 1);
  const next = student.lessons.find(l => l.generatedByCancelId === firstReplacement.id);
  assert.equal(next.date, '2026-10-27');
  assert.equal(next.entitlementId, firstReplacement.entitlementId);
  assert.equal(app.ensureFreeCancelReplacements(student), 0);
  app.recalcLessons(student);
  assert.equal(app.calcReport(student).planned, 4);
  assert.equal(student.balance, 4);
});

test('two devices repairing the same old cancellations produce the same lesson IDs', () => {
  const original = studentWithThreeFreeCancellations();
  const first = JSON.parse(JSON.stringify(original));
  const second = JSON.parse(JSON.stringify(original));
  financeHarness().ensureFreeCancelReplacements(first);
  financeHarness().ensureFreeCancelReplacements(second);
  const firstIds = first.lessons.filter(l => l.generatedByCancelId).map(l => l.id);
  const secondIds = second.lessons.filter(l => l.generatedByCancelId).map(l => l.id);
  assert.deepEqual(firstIds, secondIds);
  assert.equal(new Set([...firstIds, ...secondIds]).size, 3);
});

test('paid cancellation does not create a free replacement', () => {
  const app = financeHarness();
  const student = studentWithThreeFreeCancellations();
  student.lessons[6].status = 'paid-cancel';
  assert.equal(app.ensureFreeCancelReplacements(student), 2);
  assert.equal(student.lessons.some(l => l.generatedByCancelId === 'lesson-7'), false);
});

test('changing lesson status creates a replacement and reversing it removes that replacement', async () => {
  const app = financeHarness();
  const student = studentWithThreeFreeCancellations();
  student.id = 'student';
  student.lessons.slice(6, 9).forEach(lesson => { lesson.status = 'planned'; });
  app.state.students.push(student);

  await app.window.setLessonStatus('student', 'lesson-7', 'free-cancel');
  assert.equal(student.lessons.filter(l => l.generatedByCancelId === 'lesson-7').length, 1);
  assert.equal(student.lessons.length, 11);

  await app.window.setLessonStatus('student', 'lesson-7', 'done');
  assert.equal(student.lessons.some(l => l.generatedByCancelId === 'lesson-7'), false);
  assert.equal(student.lessons.length, 10);
});
