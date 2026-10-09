// Keep outside interactions intact: the popover closes without consuming the
// pointer event, so the clicked control can receive focus and its normal click.
export function installPopoverDismiss(panel, getTrigger, onDismiss) {
  const document = panel.ownerDocument;
  const pointerDown = event => {
    const path = event.composedPath?.() ?? [];
    const inside = node => node && (path.includes(node) || node.contains(event.target));
    if (!event.target || inside(panel) || inside(getTrigger?.())) return;
    onDismiss();
  };
  document.addEventListener('pointerdown', pointerDown, true);
  return () => document.removeEventListener('pointerdown', pointerDown, true);
}
