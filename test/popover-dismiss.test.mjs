import test from 'node:test';
import assert from 'node:assert/strict';
import { installPopoverDismiss } from '../src/popover-dismiss.mjs';

function fixture() {
  let listener, closed = 0;
  const document = {
    addEventListener(type, fn, capture) { assert.equal(type, 'pointerdown'); assert.equal(capture, true); listener = fn; },
    removeEventListener(type, fn, capture) { assert.equal(type, 'pointerdown'); assert.equal(capture, true); assert.equal(fn, listener); listener = null; },
  };
  const panelChild = {}, triggerChild = {}, outside = {};
  const panel = { ownerDocument: document, contains: target => target === panelChild };
  const trigger = { contains: target => target === triggerChild };
  let currentTrigger = trigger;
  const stop = installPopoverDismiss(panel, () => currentTrigger, () => { closed += 1; });
  const pointer = (target, path = []) => {
    let consumed = false;
    listener({ target, composedPath: () => path, preventDefault() { consumed = true; }, stopPropagation() { consumed = true; } });
    assert.equal(consumed, false, 'outside controls retain their normal interaction');
  };
  return { panel, panelChild, trigger, triggerChild, outside, stop, pointer, setTrigger(value) { currentTrigger = value; }, get closed() { return closed; }, get listening() { return !!listener; } };
}

test('pointer down outside dismisses without consuming the click', () => {
  const f = fixture();
  f.pointer(f.outside);
  assert.equal(f.closed, 1);
  f.stop();
});

test('panel and nested controls stay open, including a retargeted shadow event', () => {
  const f = fixture();
  f.pointer(f.panel, [f.panel]);
  f.pointer(f.panelChild);
  f.pointer(f.outside, [f.panelChild, f.panel]);
  assert.equal(f.closed, 0);
  f.stop();
});

test('the trigger is excluded so its click toggles the panel only once', () => {
  const f = fixture();
  f.pointer(f.trigger, [f.trigger]);
  f.pointer(f.triggerChild);
  assert.equal(f.closed, 0);
  f.setTrigger(null);
  f.pointer(f.triggerChild);
  assert.equal(f.closed, 1);
  f.stop();
});

test('unmount removes the capture listener and targetless events do not dismiss', () => {
  const f = fixture();
  f.pointer(null);
  assert.equal(f.closed, 0);
  assert.equal(f.listening, true);
  f.stop();
  assert.equal(f.listening, false);
});
