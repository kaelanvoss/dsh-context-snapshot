/** These Host prompt errors are emitted before followup/steer admission.
 * Conversation.sendSession's generic {kind:'error'} is not such evidence.
 * See the official Session.prompt contract and session-controller commands.
 */
export const CONFIRMED_PROMPT_REJECTIONS = new Set([
  'gateway/bad-request', 'session/invalid-time-zone',
  'session/attachment-invalid', 'session/not-found',
]);

export const UNCONFIRMED_SEND_NOTICE = '快照发送状态尚未确认，未自动恢复或再次发送；请先核对原会话记录。';
// The adapter proves this while Session.prompt has never been invoked for
// the identified attempt, including a lost intent ACK or local encode failure.
export const VALID_INTENT_REJECTIONS = new Set([...CONFIRMED_PROMPT_REJECTIONS, 'client/not-dispatched']);

export function confirmedPromptRejection(receipt) {
  if (receipt?.ok !== false) return undefined;
  const code = receipt.error?.code;
  return CONFIRMED_PROMPT_REJECTIONS.has(code) ? code : undefined;
}
