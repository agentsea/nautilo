/** Fixed read-only page program. No model-supplied JavaScript or selectors. */
export function browserObservationSettleExpression(timeoutMs: number): string {
  return `new Promise(resolve => {
    let frame;
    let cadence;
    let previous;
    let initialResponse;
    let sawBusy = false;
    const started = performance.now();
    let finished = false;
    const finish = ready => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      if (cadence !== undefined) clearTimeout(cadence);
      if (frame !== undefined) cancelAnimationFrame(frame);
      resolve({ ready });
    };
    const deadline = setTimeout(() => finish(false), ${JSON.stringify(timeoutMs)});
    const visible = element => element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
      && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0;
    const inspect = () => {
      if (finished) return;
      const field = document.activeElement;
      const expanded = field?.getAttribute('aria-expanded');
      const combo = field?.getAttribute('role') === 'combobox';
      const query = typeof field?.value === 'string' ? field.value.trim() : '';
      const ids = (field?.getAttribute('aria-controls') || field?.getAttribute('aria-owns') || '')
        .split(/\\s+/).filter(Boolean);
      const roots = ids.map(id => document.getElementById(id)).filter(root => root && visible(root));
      // Associated popup text includes legitimate no-results/status responses.
      // Without an association, only visible semantic responses are evidence.
      const responses = roots.length ? roots : [...document.querySelectorAll('[role="option"], [role="status"], [role="alert"]')].filter(visible);
      const response = responses.map(root => root.textContent || '').join('\\n').trim();
      if (initialResponse === undefined) initialResponse = response;
      const busy = field?.closest('[aria-busy="true"]')
        || responses.some(root => root.getAttribute('aria-busy') === 'true'
          || [...root.querySelectorAll('[aria-busy="true"]')].some(visible));
      sawBusy ||= Boolean(busy);
      const changedResponse = response !== initialResponse;
      // A collapsed combobox can start a debounced request after early checks.
      // This short grace is a heuristic, not an action deadline or success test.
      const gracePassed = performance.now() - started >= 1200;
      const responseObserved = Boolean(response) && (roots.length > 0 || changedResponse);
      const ready = document.readyState !== 'loading' && !busy
        && (!combo || changedResponse || sawBusy || gracePassed)
        && !(combo && query.length > 0 && expanded === 'true' && !responseObserved);
      const key = JSON.stringify([location.href, field?.getAttribute('role'), field?.value, expanded, response]);
      // Two matching DOM observations are a settling checkpoint, not proof
      // of task success or immunity to later asynchronous page changes.
      if (ready && previous === key) return finish(true);
      previous = ready ? key : undefined;
      schedule();
    };
    const schedule = () => {
      // Occluded Electron guests may stop compositor frames. The timer keeps
      // read-only DOM checks moving without activating the native window.
      frame = requestAnimationFrame(() => {
        frame = undefined;
        if (cadence !== undefined) clearTimeout(cadence);
        cadence = undefined;
        inspect();
      });
      cadence = setTimeout(() => {
        cadence = undefined;
        if (frame !== undefined) cancelAnimationFrame(frame);
        frame = undefined;
        inspect();
      }, 50);
    };
    schedule();
  })`;
}
