/** Shared, bounded facts for native capture, durable drafts and sent messages. */
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
export const CAPTURE_REASONS = new Set(['accessibility_permission_denied', 'accessibility_unavailable',
  'provider_read_failed', 'time_budget_reached', 'node_budget_reached', 'text_budget_reached',
  'field_truncated', 'depth_budget_reached', 'no_accessible_content', 'capture_quality_unreported']);
export function isCaptureTime(value) {
  return typeof value === 'string' && TIME.test(value) && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);
}
export function cleanCaptureString(value, limit) {
  if (typeof value !== 'string') return '';
  const clean = value.replace(CONTROL, '');
  if (clean.length <= limit) return clean;
  // Preserve composed characters at a UTF-16 budget boundary.
  let result = '';
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(clean)) {
    if (result.length + segment.length > limit) break;
    result += segment;
  }
  return result;
}
export function normalizeCaptureContext(value, text = value?.text ?? '') {
  const raw = value?.captureQuality;
  const reasons = [...new Set((Array.isArray(raw?.reasons) ? raw.reasons : []).filter(x => CAPTURE_REASONS.has(x)))];
  const addReason = reason => { if (!reasons.includes(reason)) reasons.push(reason); };
  const warn = { ui_automation_timeout: 'time_budget_reached', ui_automation_unavailable: 'accessibility_unavailable' };
  for (const item of Array.isArray(value?.warnings) ? value.warnings : []) if (warn[item] && !reasons.includes(warn[item])) reasons.push(warn[item]);
  if (typeof value?.text === 'string' && value.text.length > 16000 && !reasons.includes('text_budget_reached')) reasons.push('text_budget_reached');
  const reported = ['available', 'partial', 'image_only'].includes(raw?.status)
    && Array.isArray(raw.reasons) && raw.reasons.every(reason => CAPTURE_REASONS.has(reason))
    && !(raw.status === 'image_only' && text);
  // Preserve useful legacy failure reasons, but an unknown producer schema
  // cannot become a definite available classification merely by having text.
  if (!reported && (!reasons.length || raw)) addReason('capture_quality_unreported');
  const source = {};
  for (const [key, limit] of [['url', 4096], ['selectedText', 4000], ['focusedRole', 256], ['focusedName', 1024]]) {
    const original = value?.source?.[key];
    const field = cleanCaptureString(original, limit);
    // An omitted source is normal for older providers. Report loss only when
    // a producer supplied a field that normalization had to alter or discard.
    if (original !== undefined && original !== field) addReason('field_truncated');
    if (field) source[key] = field;
  }
  if (!text && !reasons.some(x => ['no_accessible_content', 'accessibility_permission_denied', 'accessibility_unavailable', 'provider_read_failed', 'time_budget_reached'].includes(x))) addReason('no_accessible_content');
  const captureQuality = { status: !text ? 'image_only' : raw?.status === 'partial' || reasons.length ? 'partial' : 'available', reasons };
  if (['ax', 'uia'].includes(raw?.textSource)) captureQuality.textSource = raw.textSource;
  if (Number.isSafeInteger(raw?.nodeCount) && raw.nodeCount >= 0 && raw.nodeCount <= 300) captureQuality.nodeCount = raw.nodeCount;
  if (['provider_visible_window', 'ax_visible_children_when_available', 'uia_control_view_visible'].includes(raw?.scope)) captureQuality.scope = raw.scope;
  const timing = {};
  for (const key of ['imageCapturedAt', 'textStartedAt', 'textFinishedAt']) if (isCaptureTime(value?.timing?.[key])) timing[key] = value.timing[key];
  return { captureQuality, source, timing };
}
/** Strict reader: unknown/altered schemas must never hide user-authored content. */
export function validateCaptureContext(value, text = '') {
  if (!value || typeof value !== 'object' || !value.captureQuality || !value.source || !value.timing) return false;
  const normalized = normalizeCaptureContext(value, text);
  return ['captureQuality', 'source', 'timing'].every(key => JSON.stringify(normalized[key]) === JSON.stringify(value[key]));
}
