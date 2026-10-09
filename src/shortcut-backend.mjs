const restartMessage = '快照后台尚未加载快捷键设置，请完整退出并重新打开 Harness。“重启采集”不能更新后台。';

// Package replacement can refresh the Client while Harness retains the old
// Host. Verify the live API before pausing the Harness keyboard dispatcher.
export async function setShortcutRecording(recorder, owner, active, send, onStatus) {
  let supportedCodes;
  if (active) {
    const data = await send({ op: 'status' });
    const status = data?.status;
    if (!status || typeof status !== 'object') throw new Error('无法确认快照后台状态，请重试。');
    const supportsSettings = status.shortcutApiVersion === 1 ||
      status.shortcutApiVersion === undefined && typeof status.shortcutRevision === 'string' && !!status.shortcutRevision && !!status.shortcut;
    if (!supportsSettings || status.shortcutRecordingApiVersion !== 1 || status.supportsShortcutRecording !== true || typeof recorder.begin !== 'function') throw new Error(restartMessage);
    onStatus?.(status);
    if (status.ready !== true || !Array.isArray(status.supportedCodes) || !status.supportedCodes.length || typeof status.shortcutRevision !== 'string' || !status.shortcutRevision) {
      throw new Error('采集程序尚未就绪，请先检查权限或重启采集。');
    }
    supportedCodes = status.supportedCodes;
  }
  // Cancellation must remain available even if status/transport is unhealthy.
  if (active) return recorder.begin(owner, supportedCodes);
  await recorder.update(owner, false);
}
