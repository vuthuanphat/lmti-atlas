/** Pause presentation-only ticks while the document is hidden. Owner jobs keep running. */
export function watchPresentationClock(tick: () => void, page: Pick<Document, 'hidden' | 'addEventListener' | 'removeEventListener'> = document): () => void {
  let timer: ReturnType<typeof setInterval> | undefined;
  const update = () => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
    if (!page.hidden) {
      tick();
      timer = setInterval(tick, 1000);
    }
  };
  page.addEventListener('visibilitychange', update);
  update();
  return () => { if (timer !== undefined) clearInterval(timer); page.removeEventListener('visibilitychange', update); };
}
