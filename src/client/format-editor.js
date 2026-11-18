// Format dialog: edit a step's output templates with live sample and session previews.
const FORMAT_ERRORS = {
  'unclosed-tag': 'errUnclosedTag',
  'unclosed-section': 'errUnclosedSection',
  mismatch: 'errMismatch',
  'stray-close': 'errStrayClose',
  'bad-name': 'errBadName',
  'bad-filter': 'errBadFilter',
  'filter-arg': 'errFilterArg',
  'too-long': 'errTooLong',
  'too-deep': 'errTooDeep',
  'output-too-long': 'errOutputTooLong',
};

function templateErrorText(error, t) {
  const key = FORMAT_ERRORS[error?.code];
  return key ? fmt(t(key), error.detail ?? {}) : String(error?.message ?? error);
}

/** Overrides that differ from a method's default templates. */
function formatOverridesOf(method, formats) {
  const out = {};
  for (const format of method?.formats ?? []) {
    const value = formats?.[format.key];
    if (typeof value === 'string' && value !== '' && value !== format.default) out[format.key] = value;
  }
  return out;
}

/** Live analysis of one template against its declared variables. */
function analyzeTemplate(source, format, t) {
  try {
    const tree = parseTemplate(source);
    const declared = new Set(format.vars.map(item => item.name));
    const unknown = [...templateNames(tree)].filter(name => !declared.has(name));
    let output = '';
    let renderError = '';
    try { output = renderTemplate(tree, format.sample); } catch (error) { renderError = templateErrorText(error, t); }
    const warnings = [];
    if (unknown.length > 0) warnings.push(fmt(t('formatUnknown'), { names: unknown.join(', ') }));
    if (format.marker && staticPrefix(source).trim().length < 3) warnings.push(t('formatPrefixWarn'));
    return { ok: renderError === '', error: renderError, output, warnings };
  } catch (error) {
    return { ok: false, error: templateErrorText(error, t), output: '', warnings: [] };
  }
}

function FormatDialog({ method, step, lang, t, onApply, onClose }) {
  const formats = method.formats;
  const initial = () => Object.fromEntries(formats.map(format => [format.key, step.formats?.[format.key] ?? format.default]));
  const preferred = method.id === 'fold-calls' ? ((step.options?.detail ?? method.defaults?.detail) === 'description' ? 'description' : 'summary') : formats[0].key;
  const [drafts, setDrafts] = React.useState(initial);
  const [active, setActive] = React.useState(preferred);
  const [sessions, setSessions] = React.useState(undefined);
  const [sessionId, setSessionId] = React.useState('');
  const [real, setReal] = React.useState(undefined);
  const [busy, setBusy] = React.useState(false);
  const area = React.useRef(null);
  const format = formats.find(item => item.key === active) ?? formats[0];
  const source = drafts[format.key];
  const analysis = React.useMemo(() => analyzeTemplate(source, format, t), [source, format, t]);
  const all = formats.map(item => [item, analyzeTemplate(drafts[item.key], item, t)]);
  const invalid = all.filter(([, result]) => !result.ok);
  const dirty = formats.some(item => drafts[item.key] !== (step.formats?.[item.key] ?? item.default));

  const close = () => { if (!dirty || window.confirm(t('formatDiscard'))) onClose(); };
  React.useEffect(() => {
    const onKey = event => { if (event.key === 'Escape') { event.stopPropagation(); close(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });
  React.useEffect(() => { area.current?.focus(); }, [active]);
  React.useEffect(() => {
    callHost('sessions').then(list => { setSessions(list); setSessionId(current => current || list[0]?.id || ''); }, () => setSessions([]));
  }, []);

  const setSource = value => setDrafts(current => ({ ...current, [format.key]: value }));
  const insert = text => {
    const el = area.current;
    const start = el?.selectionStart ?? source.length;
    const end = el?.selectionEnd ?? source.length;
    const next = source.slice(0, start) + text + source.slice(end);
    setSource(next);
    requestAnimationFrame(() => { if (el) { el.focus(); el.selectionStart = el.selectionEnd = start + text.length; } });
  };
  const runReal = async () => {
    if (!sessionId) return;
    setBusy(true);
    setReal(undefined);
    try {
      const preview = await callHost('preview', { sessionId, pipeline: [{ id: step.id, method: step.method, enabled: true, options: step.options ?? {}, formats: formatOverridesOf(method, drafts) }] });
      const result = preview.steps[0];
      setReal(result.error ? { error: result.error } : { items: result.items.slice(0, 3), total: result.items.length + (result.more ?? 0) });
    } catch (error) {
      setReal({ error: String(error?.message ?? error) });
    } finally {
      setBusy(false);
    }
  };
  const label = item => item.label?.[lang] ?? item.key;
  const topVars = format.vars.filter(item => !item.item);
  const itemVars = format.vars.filter(item => item.item);

  return h('div', { className: 'cm-overlay', onMouseDown: event => { if (event.target === event.currentTarget) close(); } },
    h('div', { className: 'cm-dialog', role: 'dialog', 'aria-modal': true, 'aria-label': fmt(t('formatTitle'), { name: method.name?.[lang] ?? method.id }) },
      h('header', { className: 'cm-dialog-head' },
        h('div', { className: 'cm-grow' },
          h('div', { className: 'cm-name' }, fmt(t('formatTitle'), { name: method.name?.[lang] ?? method.id })),
          h('div', { className: 'cm-sum' }, t('formatHint'))),
        h('button', { type: 'button', className: 'cm-btn ghost', 'aria-label': t('cancel'), onClick: close }, '✕')),
      formats.length > 1 ? h('div', { className: 'cm-tabs', role: 'tablist' },
        formats.map(item => h('button', {
          key: item.key, type: 'button', role: 'tab', 'aria-selected': item.key === format.key,
          className: `cm-tab${item.key === format.key ? ' active' : ''}`, onClick: () => setActive(item.key),
        }, label(item), drafts[item.key] !== item.default ? ' •' : ''))) : null,
      h('div', { className: 'cm-dialog-body' },
        h('div', { className: 'cm-dialog-col' },
          h('div', { className: 'cm-row' },
            h('span', { className: 'cm-label cm-grow' }, t('formatEditor')),
            h('span', { className: 'cm-muted cm-sum' }, fmt(t('formatLength'), { n: Array.from(source).length, max: 4000 }))),
          h('textarea', { ref: area, className: 'cm-textarea cm-template', spellCheck: false, value: source, onChange: event => setSource(event.target.value), 'aria-label': t('formatEditor') }),
          analysis.ok ? null : h('div', { className: 'cm-msg err' }, t('formatInvalid') + analysis.error),
          analysis.warnings.map((text, index) => h('div', { key: index, className: 'cm-sum cm-warn' }, text)),
          h('div', { className: 'cm-label' }, t('formatVars')),
          h('div', { className: 'cm-vars' }, topVars.map(item => h('button', { key: item.name, type: 'button', className: 'cm-var', title: item.description?.[lang], onClick: () => insert(`{{${item.name}}}`) },
            h('code', null, item.name), h('span', null, item.description?.[lang])))),
          itemVars.length > 0 ? h('div', { className: 'cm-label', style: { textTransform: 'none' } }, t('formatItemVars')) : null,
          itemVars.length > 0 ? h('div', { className: 'cm-vars' }, itemVars.map(item => h('button', { key: item.name, type: 'button', className: 'cm-var', title: item.description?.[lang], onClick: () => insert(`{{${item.name}}}`) },
            h('code', null, `· ${item.name}`), h('span', null, item.description?.[lang])))) : null,
          h('details', { className: 'cm-sum' }, h('summary', null, t('formatSyntaxTitle')), h('p', { className: 'cm-details', style: { marginTop: 6 } }, t('formatSyntax')))),
        h('div', { className: 'cm-dialog-col' },
          h('div', { className: 'cm-label' }, t('formatSample')),
          h('pre', { className: 'cm-output' }, analysis.ok ? analysis.output : ''),
          h('div', { className: 'cm-label' }, t('formatReal')),
          h('div', { className: 'cm-sum' }, t('formatRealHint')),
          h('div', { className: 'cm-row' },
            h('select', { className: 'cm-select cm-grow', 'aria-label': t('pickSession'), value: sessionId, onChange: event => { setSessionId(event.target.value); setReal(undefined); } },
              sessions === undefined ? h('option', { value: '' }, t('loading')) : sessions.map(item => h('option', { key: item.id, value: item.id }, item.title || item.id))),
            h('button', { type: 'button', className: 'cm-btn', disabled: busy || !sessionId || invalid.length > 0, onClick: runReal }, busy ? t('previewing') : t('formatRealRun'))),
          real?.error ? h('div', { className: 'cm-msg err' }, real.error) : null,
          real && !real.error && real.items.length === 0 ? h('div', { className: 'cm-sum' }, t('formatRealNone')) : null,
          real && !real.error && real.items.length > 0 ? h('div', { className: 'cm-sum cm-muted' }, fmt(t('formatRealCount'), { shown: real.items.length, total: real.total })) : null,
          real && !real.error ? real.items.map((item, index) => h('pre', { key: index, className: 'cm-output' }, item.after.replace(/^(user|tool): /, ''))) : null)),
      h('footer', { className: 'cm-dialog-foot' },
        h('button', { type: 'button', className: 'cm-btn', disabled: source === format.default, onClick: () => setSource(format.default) }, t('formatReset')),
        invalid.length > 0 ? h('span', { className: 'cm-msg err cm-grow' }, fmt(t('formatBlocked'), { names: invalid.map(([item]) => label(item)).join(', ') })) : h('span', { className: 'cm-grow' }),
        h('button', { type: 'button', className: 'cm-btn', onClick: close }, t('cancel')),
        h('button', { type: 'button', className: 'cm-btn primary', disabled: invalid.length > 0, onClick: () => onApply(formatOverridesOf(method, drafts)) }, t('formatApply')))));
}
