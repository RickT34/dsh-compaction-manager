// Basic-policy form, recall selector, and preview.
const BASIC_FIELDS = [
  ['thresholdRatio', 'thresholdRatioHint'],
  ['retainRatio', 'retainRatioHint'],
  ['retainTokens', 'retainTokensHint'],
  ['headroomTokens', 'headroomTokensHint'],
  ['maxTokens', 'maxTokensHint'],
  ['compactionRetries', 'compactionRetriesHint'],
  ['maxOverflowRetries', 'maxOverflowRetriesHint'],
];

function BasicForm({ basic, effective, t, disabled, onChange }) {
  const set = (key, value) => {
    const next = { ...basic };
    if (value === undefined || value === '') delete next[key];
    else next[key] = value;
    onChange(next);
  };
  const autoValue = basic.auto === undefined ? 'default' : (basic.auto ? 'on' : 'off');
  return h('div', { className: 'cm-fields' },
    h('label', { className: 'cm-field' },
      h('span', null, t('auto')),
      h('select', { className: 'cm-select', disabled, value: autoValue, onChange: e => set('auto', e.target.value === 'default' ? undefined : e.target.value === 'on') },
        h('option', { value: 'default' }, t('autoDefault')),
        h('option', { value: 'on' }, t('autoOn')),
        h('option', { value: 'off' }, t('autoOff'))),
      h('small', null, t('autoHint'))),
    BASIC_FIELDS.map(([key, hint]) => h(NumberField, {
      key, label: t(key), hint: t(hint), disabled, t,
      value: basic[key],
      placeholder: effective?.[key] === undefined ? '' : `${t('current')} ${effective[key]}`,
      onChange: value => set(key, value),
    })),
    h('label', { className: 'cm-field' },
      h('span', null, t('summarizationProvider')),
      h('input', { className: 'cm-input', disabled, value: basic.summarizationProvider ?? '', placeholder: effective?.summarizationProvider || '', onChange: e => set('summarizationProvider', e.target.value.trim() || undefined) }),
      h('small', null, t('summarizationHint'))),
    h('label', { className: 'cm-field' },
      h('span', null, t('summarizationModel')),
      h('input', { className: 'cm-input', disabled, value: basic.summarizationModel ?? '', placeholder: effective?.summarizationModel || '', onChange: e => set('summarizationModel', e.target.value.trim() || undefined) }),
      h('small', null, t('summarizationHint'))));
}

function RecallChooser({ value, t, disabled, onChange }) {
  return h('div', { className: 'cm-radio', role: 'radiogroup' },
    [['auto', 'recallAuto'], ['always', 'recallAlways'], ['never', 'recallNever']].map(([key, label]) => h('label', { key },
      h('input', { type: 'radio', name: 'cm-recall', disabled, checked: value === key, onChange: () => onChange(key) }),
      t(label))));
}

function PreviewItem({ item, t }) {
  const [open, setOpen] = React.useState(false);
  return h('div', { className: 'cm-item' },
    h('div', { className: 'cm-row' },
      h('span', { className: 'cm-badge' }, item.kind === 'fold' ? t('kindFold') : t('kindResult')),
      h('span', { className: 'cm-grow cm-mono' }, item.label || item.reason),
      h('span', { className: 'cm-muted' }, `${compact(item.beforeTokens)} → ${compact(item.afterTokens)}`),
      h('button', { type: 'button', className: 'cm-btn ghost', 'aria-expanded': open, onClick: () => setOpen(!open) }, open ? t('hideDiff') : t('showDiff'))),
    open ? h('div', { className: 'cm-diff' },
      h('div', null, h('div', { className: 'cm-muted' }, t('before')), h('pre', null, item.before)),
      h('div', null, h('div', { className: 'cm-muted' }, t('after')), h('pre', null, item.after))) : null);
}

function PreviewStep({ step, methods, lang, t }) {
  const [open, setOpen] = React.useState(step.items.length > 0 && step.items.length <= 6);
  const method = methods.find(m => m.id === step.method);
  const tag = stepTag(method, step.options ?? {}, lang, t);
  const name = `${method?.name?.[lang] ?? step.method}${tag ? ` · ${tag}` : ''}`;
  let summary;
  if (!step.enabled) summary = t('stepDisabled');
  else if (step.error) summary = `${t('stepError')}${step.error}`;
  else if (step.items.length === 0) summary = t('stepNothing');
  else summary = fmt(t('stepSaved'), { count: step.items.length + (step.more ?? 0), saved: compact(step.savedTokens) });
  return h('div', { className: 'cm-pstep' },
    h('header', { onClick: () => step.items.length > 0 && setOpen(!open) },
      h('span', { className: 'cm-name cm-grow' }, name),
      h('span', { className: step.error ? 'cm-msg err' : 'cm-msg' }, summary),
      step.items.length > 0 ? h('span', { className: 'cm-muted' }, open ? '▾' : '▸') : null),
    open && step.items.length > 0 ? h('div', { className: 'cm-items' },
      step.items.map((item, index) => h(PreviewItem, { key: index, item, t })),
      step.more > 0 ? h('div', { className: 'cm-item cm-muted' }, fmt(t('more'), { count: step.more })) : null) : null);
}
