// Exercise the real frontend lifecycle functions without a browser or network.
// DOM wiring is inert; this is not a browser or authentication integration test.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const clock = Date.parse('2026-11-12T12:00:00+08:00');
class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : [clock])); }
  static now() { return clock; }
}
const noop = () => {};
const node = { addEventListener: noop, insertAdjacentHTML: noop };
const context = vm.createContext({
  Date: FixedDate,
  Intl,
  URL,
  document: { querySelector: () => node, addEventListener: noop },
  window: { addEventListener: noop },
  sessionStorage: { getItem: () => null, setItem: noop },
  setInterval: noop,
  // Leave bootstrap pending: no network calls or synthetic authenticated state.
  fetch: () => new Promise(() => {}),
});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../static/app.js'), 'utf8'), context);
function call(name, ...args) {
  context.args = args;
  return vm.runInContext(`${name}(...args)`, context);
}
const receipt = { type: 'receipt', at: '2026-11-11T17:00:00+08:00' };
const response = { type: 'submission', at: '2026-11-13T09:00:00+08:00' };
const base = { stage: '评估', decision: '待评估', receipt_status: '未领取', deadlines: [receipt, response] };

test('date-only deadline stays open until next Beijing midnight', () => {
  const deadline = { type: 'submission', at: '2026-11-12', date_only: true };
  assert.equal(call('deadlinePassed', deadline, Date.parse('2026-11-12T23:59:59+08:00')), false);
  assert.equal(call('deadlinePassed', deadline, Date.parse('2026-11-13T00:00:00+08:00')), true);
  assert.equal(call('dayKey', '2026-11-12T16:01:00Z'), '2026-11-13');
});

test('receipt status distinguishes missed, pending, and received documents', () => {
  assert.equal(call('projectStatus', base).archived, true);
  const pending = call('projectStatus', { ...base, receipt_status: '已申请' });
  assert.equal(pending.archived, false);
  assert.equal(pending.reason, 'pending');
  assert.equal(call('projectStatus', { ...base, receipt_status: '已领取' }).archived, false);
});

test('submission deadline expires applications, while submitted bids await results', () => {
  const past = { ...base, receipt_status: '已申请', deadlines: [{ ...response, at: '2026-11-12T09:00:00+08:00' }] };
  assert.equal(call('projectStatus', past).reason, 'submission');
  const submitted = call('projectStatus', { ...past, stage: '已递交' });
  assert.equal(submitted.archived, false);
  assert.equal(submitted.reason, 'result');
});

test('historical nodes and auxiliary deadlines cannot expire a project', () => {
  const project = { ...base, deadlines: [
    { ...receipt, is_current: false },
    { type: 'clarification', at: '2026-11-10T12:00:00+08:00' },
    response,
  ] };
  assert.equal(call('projectStatus', project).archived, false);
  assert.equal(call('validDeadlines', project).length, 2);
});

test('abandoned projects are excluded from active, pending and upcoming counts', () => {
  const project = { ...base, decision: '放弃', deadlines: [response] };
  assert.equal(call('discarded', project), true);
  assert.equal(call('inactive', project), true);
  assert.equal(call('soon', project), false);
  assert.equal(call('pendingReceipt', project), false);
  assert.equal(call('inactive', { ...project, decision: '待评估' }), false);
});
