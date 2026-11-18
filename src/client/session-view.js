// Session view tab: choose this session's compaction preset, preview it, and compact now.
function SessionPresetPicker({ info, form, sessionId, lang, t, onChanged }) {
  const snap = useStore(cb => form.subscribe(cb), () => form.getSnapshot());
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState('');
  const writable = snap.status === 'ready' && snap.writable;
  const name = preset => preset?.name?.[lang] ?? preset?.id ?? '';
  const builtin = info.presets.filter(preset => !preset.user);
  const user = info.presets.filter(preset => preset.user);
  const choice = info.choice ?? '';
  const resolution = info.resolution;

  const choose = async value => {
    setSaving(true);
    setError('');
    try {
      // Removing the last choice removes the whole map, leaving no empty entry behind.
      const path = value === '' && info.otherChoices === 0 ? ['sessionPresets'] : ['sessionPresets', sessionId];
      const op = value === '' ? { op: 'unset', path } : { op: 'set', path, value };
      const ok = await form.mutate([op], form.getSnapshot().revision);
      if (!ok) throw new Error(t('notServed'));
      await new Promise(resolve => setTimeout(resolve, 300));
      await onChanged();
    } catch (e) {
      setError(t('sessionPresetFailed') + String(e?.message ?? e));
    } finally {
      setSaving(false);
    }
  };

  let note;
  if (resolution.missing && resolution.missing.sessionId === sessionId) note = h('span', { className: 'cm-warn' }, fmt(t('sessionPresetMissing'), { id: resolution.missing.presetId }));
  else if (resolution.source === 'parent') note = fmt(t('sessionPresetInherited'), { name: resolution.presetName?.[lang] ?? resolution.presetId });
  else if (resolution.source === 'global') note = t('sessionPresetGlobal');
  else note = t('sessionPresetOwn');

  return h('div', { className: 'cm-section', style: { padding: '12px 14px' } },
    h('div', { className: 'cm-row' },
      h('label', { className: 'cm-name', htmlFor: 'cm-session-preset' }, t('sessionPresetLabel')),
      h('select', {
        id: 'cm-session-preset', className: 'cm-select cm-grow', disabled: !writable || saving, value: choice,
        onChange: event => choose(event.target.value),
      },
        h('option', { value: '' }, info.parent && resolution.source === 'parent' ? t('sessionPresetInherit') : t('sessionPresetFollow')),
        h('optgroup', { label: t('presets') }, builtin.map(preset => h('option', { key: preset.id, value: preset.id }, name(preset)))),
        user.length > 0 ? h('optgroup', { label: t('presetUser') }, user.map(preset => h('option', { key: preset.id, value: preset.id }, name(preset)))) : null,
        choice && !info.presets.some(preset => preset.id === choice) ? h('option', { value: choice }, fmt(t('sessionPresetGone'), { id: choice })) : null),
      saving ? h('span', { className: 'cm-muted cm-sum' }, t('saving')) : null),
    h('div', { className: 'cm-sum', style: { marginTop: 6 } }, note, ' ', t('sessionPresetHint')),
    !writable ? h('div', { className: 'cm-sum cm-muted' }, snap.status === 'ready' ? t('readOnly') : t('notServed')) : null,
    error ? h('div', { className: 'cm-msg err' }, error) : null);
}

function SessionCompactionView({ ctx, sessionId, form }) {
  useStore(cb => ctx.locale.subscribe(cb), () => ctx.locale.getSnapshot?.().revision ?? langOf(ctx));
  const t = makeT(ctx);
  const lang = langOf(ctx);
  const [state, setState] = React.useState(undefined);
  const [info, setInfo] = React.useState(undefined);
  const [result, setResult] = React.useState(undefined);
  const [manual, setManual] = React.useState(undefined);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');

  const refresh = React.useCallback(async () => {
    if (!sessionId) return;
    setBusy(true);
    setError('');
    try {
      const [nextState, nextInfo] = await Promise.all([callHost('state'), callHost('session-compaction', { sessionId })]);
      setState(nextState);
      setInfo(nextInfo);
      const preview = await callHost('preview', { sessionId });
      setResult(preview);
      setManual(preview.manual);
    } catch (e) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }, [sessionId]);
  React.useEffect(() => { setResult(undefined); setManual(undefined); refresh(); }, [refresh]);

  // While a request waits for the next step, poll its status; refresh once it ran.
  React.useEffect(() => {
    if (!manual?.queuedAt) return undefined;
    const lastAt = manual.last?.at ?? 0;
    const timer = setInterval(async () => {
      try {
        const status = await callHost('session-status', { sessionId });
        setManual(status);
        if (!status.queuedAt && (status.last?.at ?? 0) > lastAt) refresh();
      } catch { /* keep polling */ }
    }, 2000);
    return () => clearInterval(timer);
  }, [manual?.queuedAt, manual?.last?.at, sessionId, refresh]);

  const compactNow = async () => {
    setError('');
    try { setManual(await callHost('compact-now', { sessionId })); } catch (e) { setError(String(e?.message ?? e)); }
  };
  const cancel = async () => {
    try { setManual(await callHost('compact-now', { sessionId, cancel: true })); } catch (e) { setError(String(e?.message ?? e)); }
  };
  const openPanel = () => { try { ctx.get('layout')?.selectPanel(PANEL_ID); } catch { /* not registered */ } };

  const saved = result ? result.beforeTokens - result.afterTokens : 0;
  const percent = result && result.beforeTokens > 0 ? `${((saved / result.beforeTokens) * 100).toFixed(1)}%` : '0%';
  const enabled = (result?.resolution?.pipeline ?? info?.resolution?.pipeline ?? []).filter(step => step.enabled);
  const names = enabled.map(step => state.methods.find(m => m.id === step.method)?.name?.[lang] ?? step.method);
  const changes = result ? result.steps.reduce((sum, step) => sum + step.items.length + (step.more ?? 0), 0) : 0;

  let manualLine = null;
  if (manual?.queuedAt) {
    manualLine = h('div', { className: 'cm-bar' },
      h('span', { className: 'cm-msg cm-grow' }, manual.agentStatus === 'running' ? t('queuedRunning') : t('queuedIdle')),
      h('button', { type: 'button', className: 'cm-btn', onClick: cancel }, t('cancelQueued')));
  } else if (manual?.last) {
    const last = manual.last;
    manualLine = h('p', { className: `cm-msg ${last.error ? 'err' : 'ok'}` }, last.error
      ? `${t('compactFailed')}${last.error}`
      : fmt(t('compactDone'), { count: last.applied, saved: compact(last.tokensSaved), time: new Date(last.at).toLocaleTimeString() }));
  }

  return h('div', { className: 'cm-page' },
    h('style', null, CSS),
    h('div', { className: 'cm-inner', style: { maxWidth: 980, padding: '18px 20px 48px', gap: 14 } },
      h('div', { className: 'cm-row' },
        h('div', { className: 'cm-grow' },
          h('div', { className: 'cm-name' }, t('viewTitle')),
          h('div', { className: 'cm-hint', style: { margin: 0 } }, names.length > 0 ? fmt(t('viewSteps'), { steps: names.join(' → ') }) : t('viewNoSteps'))),
        h('button', { type: 'button', className: 'cm-btn', onClick: openPanel }, t('viewSettings')),
        h('button', { type: 'button', className: 'cm-btn', disabled: busy, onClick: refresh }, busy ? t('previewing') : t('viewRefresh')),
        h('button', { type: 'button', className: 'cm-btn primary', disabled: busy || !result || changes === 0 || Boolean(manual?.queuedAt), onClick: compactNow }, t('compactNow'))),
      info ? h(SessionPresetPicker, { info, form, sessionId, lang, t, onChanged: refresh }) : null,
      h('p', { className: 'cm-hint', style: { margin: 0 } }, t('compactNowHint')),
      manualLine,
      error ? h('p', { className: 'cm-msg err' }, error) : null,
      result ? h('div', null,
        h('div', { className: 'cm-total' },
          h('b', null, fmt(t('beforeAfter'), { before: compact(result.beforeTokens), after: compact(result.afterTokens), saved: compact(saved), percent })),
          h('span', { className: 'cm-muted' }, fmt(t('surfaceInfo'), { nodes: result.nodes, tools: result.toolResults }))),
        h('div', { className: 'cm-meter' }, h('div', { style: { width: `${result.beforeTokens > 0 ? Math.max(0, Math.min(100, (result.afterTokens / result.beforeTokens) * 100)) : 100}%` } })),
        changes === 0 ? h('p', { className: 'cm-hint' }, t('viewNothing')) : null,
        result.steps.filter(step => step.enabled).map(step => h(PreviewStep, { key: step.id ?? step.method, step, methods: state.methods, lang, t }))) : (busy ? h('p', { className: 'cm-muted' }, t('previewing')) : null)));
}
