// The transaction around one decision. Kept outside the MCP registration so
// tests can exercise failures, dry-runs and retries without an HTTP server.
const ALLOWED = {
  post_due: ['publish', 'skip'],
  comment: ['reply', 'skip'],
};

export function validateKindAction(event, action) {
  const allowed = ALLOWED[event?.kind] ?? [];
  if (!allowed.includes(action)) {
    throw new Error(
      `action "${action}" does not match ${event?.kind ?? 'unknown'} event; allowed: ${allowed.join(', ') || 'none'}`
    );
  }
}

function assertRetryAllowed(event, retry) {
  if (event.lastAttempt?.ambiguous && !retry) {
    throw new Error(
      `event ${event.id} has an ambiguous previous ${event.lastAttempt.action ?? 'send'} attempt; ` +
        'check the platform and pass retry=true to send again'
    );
  }
}

function markCommentHandled(data, event) {
  if (event.commentId) {
    const comment = data.state.inbound.find((item) => item.id === event.commentId);
    if (comment) comment.handled = true;
    if (!data.state.commentDone) data.state.commentDone = {};
    data.state.commentDone[event.commentId] = new Date().toISOString();
  }
  if (event.kind === 'post_due' && event.slotId && event.occurrence) {
    if (!data.state.slotDone) data.state.slotDone = {};
    const previous = data.state.slotDone[event.slotId];
    const previousAt = Date.parse(previous);
    if (!previous || !Number.isFinite(previousAt) || Date.parse(event.occurrence) > previousAt) {
      data.state.slotDone[event.slotId] = event.occurrence;
    }
  }
}

function successEntry(event, { action, text, reason }) {
  return {
    ...event,
    action,
    text: text ?? '',
    reason: reason ?? '',
    at: new Date().toISOString(),
  };
}

export async function decideEvent({
  data,
  social,
  event_id,
  action,
  text,
  reason,
  perform = false,
  retry = false,
}) {
  const event = data.state.events.find((item) => item.id === event_id);
  if (!event) throw new Error(`unknown or already-decided event: ${event_id}`);
  validateKindAction(event, action);
  if (action !== 'skip' && !text?.trim()) throw new Error(`${action} needs text`);

  // A skip is a decision on its own; it has no side effect to dry-run.
  if (action === 'skip') {
    const taken = data.takeEvent(event_id);
    if (!taken) throw new Error(`unknown or already-decided event: ${event_id}`);
    const entry = successEntry(taken, { action, text: '', reason });
    data.state.history.push(entry);
    markCommentHandled(data, taken);
    data.log({ type: 'decision', entry });
    data.save();
    return { ok: true, decided: 'skip' };
  }

  // Dry-run must be non-destructive: the event stays queued and no history is
  // written, so the same event can still be performed later.
  if (!perform) return { ok: true, decided: action, dryRun: true };

  assertRetryAllowed(event, retry);
  const claimed = data.takeEvent(event_id);
  if (!claimed) throw new Error(`unknown or already-decided event: ${event_id}`);

  try {
    data.beginAttempt(claimed, { action, text, reason });
  } catch (err) {
    // A failed beginAttempt may still have written the in-memory claim before
    // save() threw. Clear it before restoring the event.
    data.finishAttempt?.(claimed.id);
    data.restoreEvent(claimed);
    throw err;
  }

  let performed;
  try {
    const result =
      claimed.kind === 'post_due'
        ? await social.publish(text, [], { idempotencyKey: claimed.id })
        : await social.reply(claimed.commentId, text, { idempotencyKey: claimed.id });
    if (!result?.id) {
      const err = new Error('platform returned no id');
      err.definitive = false;
      throw err;
    }
    performed = result.id;
  } catch (err) {
    // 4xx is a definite rejection. Network errors, timeouts and 5xx may have
    // reached the platform, so retrying needs an explicit retry=true.
    const ambiguous = err.definitive !== true;
    data.failAttempt(claimed.id, { error: err.message, ambiguous });
    data.log({
      type: 'decision_error',
      entry: successEntry(claimed, { action, text, reason }),
      message: String(err.message ?? err),
      ambiguous,
    });
    try {
      data.save();
    } catch (saveErr) {
      data.log({ type: 'save_error', message: String(saveErr.message ?? saveErr) });
    }
    const error = new Error(
      `${action} failed: ${err.message}. Event ${claimed.id} was kept` +
        (ambiguous ? '; the previous attempt may have succeeded, so check the platform and pass retry=true.' : '.')
    );
    error.cause = err;
    throw error;
  }

  const entry = successEntry(claimed, { action, text, reason });
  entry.performed = performed;
  data.state.history.push(entry);
  markCommentHandled(data, claimed);
  data.finishAttempt(claimed.id);
  data.log({ type: 'decision', entry });
  try {
    data.save();
  } catch (err) {
    data.log({ type: 'save_error', message: String(err.message ?? err) });
    throw new Error(`sent successfully but could not save state: ${err.message}`);
  }
  return { ok: true, decided: action, performed };
}
