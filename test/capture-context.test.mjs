import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCapture } from '../src/protocol.mjs';
import { normalizeCaptureContext, validateCaptureContext, cleanCaptureString } from '../src/capture-context.mjs';
import { contextText } from '../src/draft.mjs';
import { parseSnapshotPresentation } from '../src/presentation-data.mjs';
const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';
const snapshotId = 'e2576245-a281-4df1-a012-67372d49f561';
const raw = { pngBase64, appName: 'Fixture', title: 'Work scene', capturedAt: '2026-10-09T00:00:01Z',
  text: 'button (focused) Run\ncheckbox (checked) Preserve parameters',
  captureQuality: { status: 'partial', reasons: ['node_budget_reached'], textSource: 'ax', nodeCount: 300, scope: 'provider_visible_window' },
  source: { url: 'http://127.0.0.1:8770/scene.html', selectedText: 'build 42', focusedRole: 'AXButton', focusedName: 'Run' },
  timing: { imageCapturedAt: '2026-10-09T00:00:00Z', textStartedAt: '2026-10-09T00:00:00Z', textFinishedAt: '2026-10-09T00:00:01Z' } };
test('capture quality, work target and observed timestamps survive validation and strict sent projection', () => {
  const capture = { ...validateCapture(raw), snapshotId };
  const envelope = contextText(capture);
  const name = `window-snapshot-${snapshotId}-2026-10-09T00-00-01Z.png`;
  const image = { type: 'image', value: { name, previewUrl: 'blob:fixture' } };
  const projected = parseSnapshotPresentation(envelope, [image]);
  assert.ok(projected);
  assert.equal(projected.text, '');
  assert.deepEqual(projected.snapshots[0].captureQuality, raw.captureQuality);
  assert.deepEqual(projected.snapshots[0].source, raw.source);
  assert.deepEqual(projected.snapshots[0].timing, raw.timing);
  assert.match(envelope, /"version":3/);
});
test('display icons do not become model text in current capture protocol', () => {
  const envelope = contextText({ ...validateCapture(raw), snapshotId, appIconPngBase64: pngBase64 });
  assert.equal(envelope.includes(pngBase64), false);
  assert.equal(envelope.includes('appIconPngBase64'), false);
  assert.ok(envelope.includes('Preserve parameters'));
});
test('legacy native warnings and final protocol truncation are factual partial/image-only reasons', () => {
  const { captureQuality, ...legacy } = raw;
  const limited = validateCapture({ ...legacy, text: 'x'.repeat(17000), warnings: ['ui_automation_timeout'] });
  assert.equal(limited.captureQuality.status, 'partial');
  assert.deepEqual(limited.captureQuality.reasons, ['time_budget_reached', 'text_budget_reached']);
  const absent = validateCapture({ ...legacy, text: '', warnings: ['ui_automation_unavailable'] });
  assert.equal(absent.captureQuality.status, 'image_only');
  assert.deepEqual(absent.captureQuality.reasons, ['accessibility_unavailable']);
});
test('missing timestamps cannot be replaced with a fabricated capture instant', () => {
  for (const capturedAt of ['', undefined, '2026-02-30T00:00:00Z']) assert.throws(() => validateCapture({ ...raw, capturedAt }), /timestamp/);
});
test('context metadata is bounded, canonical and preserves composed text at limits', () => {
  assert.equal(cleanCaptureString('x👩‍💻y', 3), 'x');
  const context = normalizeCaptureContext(raw, raw.text);
  assert.equal(validateCaptureContext(context, raw.text), true);
  assert.equal(validateCaptureContext({ ...context, source: { ...context.source, arbitrary: 'field' } }, raw.text), false);
  assert.equal(validateCaptureContext({ ...context, captureQuality: { ...context.captureQuality, status: 'available' } }, raw.text), false);
});
test('unknown producer quality cannot be presented as an available text capture', () => {
  for (const captureQuality of [undefined, {}, { status: 'future', reasons: [] },
    { status: 'available', reasons: ['unknown_provider_reason'] }, { status: 'image_only', reasons: [] }]) {
    const capture = { ...validateCapture({ ...raw, captureQuality }), snapshotId };
    assert.equal(capture.captureQuality.status, 'partial');
    assert.ok(capture.captureQuality.reasons.includes('capture_quality_unreported'));
    const image = { type: 'image', value: { name: `window-snapshot-${snapshotId}-2026-10-09T00-00-01Z.png`, previewUrl: 'blob:fixture' } };
    assert.ok(parseSnapshotPresentation(contextText(capture), [image]), 'normalized v3 must keep exact presentation pairing');
  }
});
test('source field loss becomes a visible quality reason without penalizing an omitted source', () => {
  const quality = { status: 'available', reasons: [], textSource: 'uia', nodeCount: 2, scope: 'uia_control_view_visible' };
  const native = { ...raw, captureQuality: quality, source: undefined };
  assert.deepEqual(validateCapture(native).captureQuality, quality);
  const modified = validateCapture({ ...native, source: {
    selectedText: `${'x'.repeat(3999)}👩‍💻`, focusedName: null, focusedRole: 'AX\u0000Button',
  } });
  assert.equal(modified.captureQuality.status, 'partial');
  assert.deepEqual(modified.captureQuality.reasons, ['field_truncated']);
  assert.equal(modified.source.selectedText, 'x'.repeat(3999));
  assert.equal(modified.source.focusedRole, 'AXButton');
  assert.equal(Object.hasOwn(modified.source, 'focusedName'), false);
  assert.equal(validateCaptureContext(modified, modified.text), true);
});
test('legal bounded native quality, source and high precision timings remain unchanged', () => {
  const captureQuality = { status: 'available', reasons: [], textSource: 'ax', nodeCount: 12, scope: 'ax_visible_children_when_available' };
  const timing = { imageCapturedAt: '2026-10-09T00:00:01.1234567Z', textStartedAt: '2026-10-09T00:00:00.120Z', textFinishedAt: '2026-10-09T00:00:00.921Z' };
  const capture = validateCapture({ ...raw, captureQuality, timing });
  assert.deepEqual(capture.captureQuality, captureQuality);
  assert.deepEqual(capture.source, raw.source);
  assert.deepEqual(capture.timing, timing);
});
