import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync('chatgpt-gateway.user.js', 'utf8');
const block = source.slice(
  source.indexOf('  const sendSelectors = ['),
  source.indexOf('  const assistants ='),
);

function harness({ label = '发送', form = false, delay = 0, disabled = false, cancel = false } = {}) {
  let clicks = 0;
  let ticks = 0;
  let enabled = !disabled && delay === 0;
  const status = [];
  const job = { cancelled: false };
  const button = {
    hidden: false,
    get disabled() { return !enabled; },
    getAttribute(name) { return name === 'aria-label' ? label : null; },
    getClientRects() { return [1]; },
    click() { clicks++; },
  };
  const scope = { querySelectorAll(selector) {
    if (selector.includes('type="submit"')) return form ? [button] : [];
    return selector.includes('aria-label="' + label + '"') ? [button] : [];
  } };
  const document = { querySelectorAll(selector) { return scope.querySelectorAll(selector); } };
  const context = {
    document,
    findInput: () => ({ closest: () => form ? scope : null }),
    showStatus: message => status.push(message),
    sleep: async () => {
      ticks++;
      if (delay && ticks >= delay) enabled = true;
      if (cancel || ticks > 5) job.cancelled = true;
    },
  };
  vm.runInNewContext(block + '\nthis.api = { sendButton, clickSend };', context);
  return {
    api: context.api,
    button,
    job,
    status,
    clicks: () => clicks,
    ticks: () => ticks,
  };
}

test('Chinese send labels submit automatically without a human click', async () => {
  for (const label of ['发送', '发送提示', '发送消息', '傳送', 'Send prompt']) {
    const h = harness({ label });
    assert.equal(h.api.sendButton(), h.button, label);
    await h.api.clickSend(h.job);
    assert.equal(h.clicks(), 1, label);
    assert.equal(h.job.submitted, true, label);
  }
});

test('form-associated submit works without an English label or legacy id', async () => {
  const h = harness({ label: '', form: true });
  assert.equal(h.api.sendButton(), h.button);
  await h.api.clickSend(h.job);
  assert.equal(h.clicks(), 1);
});

test('a delayed send button is clicked exactly once when it becomes ready', async () => {
  const h = harness({ delay: 3 });
  await h.api.clickSend(h.job);
  assert.equal(h.clicks(), 1);
  assert.equal(h.ticks(), 3);
  assert.equal(h.job.submitted, true);
});

test('disabled or absent send button is not forced and cancellation is honored', async () => {
  const h = harness({ disabled: true, cancel: true });
  assert.equal(h.api.sendButton(), null);
  await assert.rejects(h.api.clickSend(h.job), /取消/);
  assert.equal(h.clicks(), 0);
  assert.equal(h.job.submitted, undefined);
});

test('waiting does not flood logs or impose a fixed submit deadline', async () => {
  const h = harness({ disabled: true });
  await assert.rejects(h.api.clickSend(h.job), /取消/);
  assert.equal(h.status.length, 1);
  assert.doesNotMatch(block, /i < 60/);
});
