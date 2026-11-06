export interface SwipeHandlers {
  onMove(dx: number): void;
  /** Return true when the gesture committed to an action. */
  onRelease(dx: number, velocity: number): void;
  threshold?: number;
}

/** Pointer-events drag (mouse, touch, pen). Vertical scroll stays native via touch-action: pan-y. */
export function attachSwipe(el: HTMLElement, h: SwipeHandlers, enabled: () => boolean): () => void {
  let startX = 0;
  let startY = 0;
  let lastX = 0;
  let lastT = 0;
  let v = 0;
  let id = -1;
  let dragging = false;

  const down = (e: PointerEvent) => {
    if (!enabled() || id !== -1 || (e.pointerType === 'mouse' && e.button !== 0)) return;
    id = e.pointerId;
    startX = lastX = e.clientX;
    startY = e.clientY;
    lastT = e.timeStamp;
    v = 0;
    dragging = false;
  };
  const move = (e: PointerEvent) => {
    if (e.pointerId !== id) return;
    const dx = e.clientX - startX;
    if (!dragging) {
      if (Math.abs(dx) < 6 || Math.abs(dx) < Math.abs(e.clientY - startY)) return;
      dragging = true;
      el.setPointerCapture(id);
      el.classList.add('dragging');
    }
    const dt = Math.max(1, e.timeStamp - lastT);
    v = (e.clientX - lastX) / dt;
    lastX = e.clientX;
    lastT = e.timeStamp;
    h.onMove(dx);
  };
  const up = (e: PointerEvent) => {
    if (e.pointerId !== id) return;
    const was = dragging;
    id = -1;
    dragging = false;
    el.classList.remove('dragging');
    if (was) h.onRelease(e.clientX - startX, v);
  };
  el.addEventListener('pointerdown', down);
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  // Suppress the click that follows a mouse drag.
  const click = (e: Event) => {
    if (Math.abs(lastX - startX) > 6) e.stopPropagation();
  };
  el.addEventListener('click', click, true);
  return () => {
    el.removeEventListener('pointerdown', down);
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    el.removeEventListener('pointercancel', up);
    el.removeEventListener('click', click, true);
  };
}
