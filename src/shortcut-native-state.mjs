const states = new Set(['waiting', 'holding', 'complete', 'too_many', 'interrupted', 'expired', 'ended']);
const tokenPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function validRecordingToken(token) { return typeof token === 'string' && tokenPattern.test(token); }

/** Accept only physical codes from this exact, short-lived recording. */
export function validateNativeRecordingState(value, token, supportedCodes) {
  if (!validRecordingToken(token) || !value || value.token !== token || !states.has(value.state) ||
    Object.keys(value).sort().join(',') !== 'current,peak,state,token') throw new Error('原生录入状态未确认，请重新录入。');
  const supported = new Set(supportedCodes);
  for (const codes of [value.current, value.peak]) {
    if (!Array.isArray(codes) || codes.length > 2 || new Set(codes).size !== codes.length ||
      codes.some(code => typeof code !== 'string' || !supported.has(code))) throw new Error('原生录入按键无效，请重新录入。');
  }
  const terminal = ['too_many', 'interrupted', 'expired', 'ended'].includes(value.state);
  if ((terminal || value.state === 'waiting') && (value.current.length || value.peak.length) ||
    value.state === 'complete' && (value.current.length || !value.peak.length) ||
    value.state === 'holding' && (!value.current.length || !value.peak.length) ||
    value.current.some(code => !value.peak.includes(code))) throw new Error('原生录入状态不一致，请重新录入。');
  return { token, state: value.state, current: [...value.current], peak: [...value.peak] };
}
