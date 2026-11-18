// Pipeline editor: ordered steps, per-method description and options.
function NumberField({ label, hint, def, value, disabled, t, onChange, placeholder }) {
  const [text, setText] = React.useState(value === undefined ? '' : String(value));
  React.useEffect(() => { setText(value === undefined ? '' : String(value)); }, [value]);
  const bad = text.trim() !== '' && !Number.isFinite(Number(text));
  return h('label', { className: 'cm-field' },
    h('span', null, label),
    h('input', {
      className: `cm-input${bad ? ' bad' : ''}`, inputMode: 'decimal', disabled, value: text,
      placeholder: placeholder ?? (def === undefined ? '' : String(def)),
      onChange: e => {
        setText(e.target.value);
        const raw = e.target.value.trim();
        if (raw === '') onChange(undefined);
        else if (Number.isFinite(Number(raw))) onChange(Number(raw));
      },
    }),
    hint !== undefined || def !== undefined ? h('small', null, [def !== undefined ? `${t('defaultValue')}: ${def}` : '', hint ?? ''].filter(Boolean).join(' · ')) : null);
}

function StepOptionField({ option, value, lang, t, disabled, onChange }) {
  const label = option.label?.[lang] ?? option.key;
  const hint = option.hint?.[lang];
  const def = option.default;
  if (option.type === 'boolean') {
    return h('label', { className: 'cm-field' },
      h('span', null, label),
      h('div', { className: 'cm-row' },
        h('button', { type: 'button', role: 'switch', 'aria-checked': value === true, className: 'cm-switch', disabled, onClick: () => onChange(!(value === true)) }),
        h('small', null, `${t('defaultValue')}: ${def ? 'on' : 'off'}${hint ? ` · ${hint}` : ''}`)));
  }
  if (option.type === 'list') {
    const text = Array.isArray(value) ? value.join('\n') : '';
    return h('label', { className: 'cm-field' },
      h('span', null, label),
      h('textarea', { className: 'cm-textarea', disabled, value: text, onChange: e => onChange(e.target.value.split('\n').map(s => s.trim()).filter(Boolean)) }),
      h('small', null, `${t('listHint')} · ${t('defaultValue')}: ${(def ?? []).join(', ') || '–'}`));
  }
  if (option.type === 'select') {
    return h('label', { className: 'cm-field' },
      h('span', null, label),
      h('select', { className: 'cm-select', disabled, value: value ?? def, onChange: e => onChange(e.target.value) },
        (option.choices ?? []).map(choice => h('option', { key: choice.value, value: choice.value }, choice.label?.[lang] ?? choice.value))));
  }
  if (option.type === 'number') return h(NumberField, { label, hint, def, value, disabled, t, onChange });
  return h('label', { className: 'cm-field' },
    h('span', null, label),
    h('input', { className: 'cm-input', disabled, value: value ?? '', placeholder: String(def ?? ''), onChange: e => onChange(e.target.value === '' ? undefined : e.target.value) }));
}

/** Short tag of a step's distinguishing options, e.g. "> 200 · read, skill". */
function stepTag(method, options, lang, t) {
  if (!method) return '';
  const parts = [];
  for (const key of method.tagKeys ?? []) {
    const option = method.options.find(item => item.key === key);
    if (!option) continue;
    const value = options[key] ?? method.defaults?.[key];
    if (option.type === 'list') {
      if (!Array.isArray(value) || value.length === 0) continue;
      const shown = value.slice(0, 4).join(', ') + (value.length > 4 ? ` +${value.length - 4}` : '');
      parts.push(`${key === 'excludeTools' ? t('tagExclude') : t('tagOnly')} ${shown}`);
    } else if (option.type === 'select') {
      const choice = option.choices?.find(item => item.value === value);
      parts.push(choice?.label?.[lang] ?? String(value));
    } else if (option.type === 'number') {
      if (value === 0 && /\b0\b/.test(option.label?.en ?? '')) continue;
      parts.push(`${option.label?.[lang] ?? key} ${value}`);
    }
  }
  return parts.join(' · ');
}

function StepCard({ step, index, count, method, lang, t, disabled, onToggle, onMove, onRemove, onOptions, onFormats }) {
  const [open, setOpen] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  const customFormats = Object.keys(formatOverridesOf(method, step.formats)).length > 0;
  const missing = method === undefined;
  const name = missing ? step.method : (method.name?.[lang] ?? method.id);
  const options = step.options ?? {};
  const effective = method ? { ...method.defaults, ...options } : options;
  const recall = method?.id === 'trim-head-tail' ? effective.recallHint === true : method?.recall;
  const tag = stepTag(method, options, lang, t);
  return h('div', { className: `cm-step${step.enabled ? '' : ' off'}` },
    h('div', { className: 'cm-step-top' },
      h('div', { className: 'cm-idx' }, index + 1),
      h('div', { className: 'cm-grow' },
        h('div', { className: 'cm-row' },
          h('span', { className: 'cm-name' }, name),
          method && !method.builtin ? h('span', { className: 'cm-badge' }, t('extension')) : null,
          missing ? h('span', { className: 'cm-badge warn' }, t('missingMethod')) : h('span', { className: 'cm-badge' }, recall ? t('recallYes') : t('recallNo')),
          customFormats ? h('span', { className: 'cm-badge brand' }, t('formatCustom')) : null),
        tag ? h('div', { className: 'cm-sum cm-mono' }, tag) : null,
        method ? h('div', { className: 'cm-sum' }, method.summary?.[lang]) : null),
      h('button', { type: 'button', className: 'cm-btn ghost', title: t('moveUp'), 'aria-label': t('moveUp'), disabled: disabled || index === 0, onClick: () => onMove(-1) }, '↑'),
      h('button', { type: 'button', className: 'cm-btn ghost', title: t('moveDown'), 'aria-label': t('moveDown'), disabled: disabled || index === count - 1, onClick: () => onMove(1) }, '↓'),
      method ? h('button', { type: 'button', className: 'cm-btn ghost', 'aria-expanded': open, onClick: () => setOpen(!open) }, open ? t('hideDetails') : t('details')) : null,
      h('button', { type: 'button', className: 'cm-btn ghost', title: t('removeStep'), 'aria-label': `${t('removeStep')}: ${name}`, disabled, onClick: onRemove }, '✕'),
      h('button', { type: 'button', role: 'switch', 'aria-checked': step.enabled, 'aria-label': `${t('enabled')}: ${name}`, className: 'cm-switch', disabled: disabled || missing, onClick: onToggle })),
    open && method ? h('div', { className: 'cm-body' },
      h('p', { className: 'cm-details' }, method.details?.[lang]),
      (method.formats ?? []).length > 0 ? h('div', { className: 'cm-row' },
        h('button', { type: 'button', className: 'cm-btn', disabled, onClick: () => setEditing(true) }, t('formatButton')),
        h('span', { className: 'cm-sum' }, customFormats ? t('formatCustomHint') : t('formatDefaultHint')),
        customFormats ? h('button', { type: 'button', className: 'cm-btn ghost', disabled, onClick: () => onFormats({}) }, t('formatResetAll')) : null) : null,
      method.options.length > 0 ? h('div', { className: 'cm-fields' },
        method.options.map(option => h(StepOptionField, {
          key: option.key, option, lang, t, disabled,
          value: options[option.key] ?? method.defaults?.[option.key],
          onChange: value => {
            const next = { ...options };
            if (value === undefined || JSON.stringify(value) === JSON.stringify(method.defaults?.[option.key])) delete next[option.key];
            else next[option.key] = value;
            onOptions(next);
          },
        }))) : null,
      Object.keys(options).length > 0 ? h('div', null, h('button', { type: 'button', className: 'cm-btn', disabled, onClick: () => onOptions({}) }, t('resetOptions'))) : null) : null,
    editing && method ? h(FormatDialog, { method, step, lang, t, onClose: () => setEditing(false), onApply: formats => { onFormats(formats); setEditing(false); } }) : null);
}

function uniqueStepId(pipeline, base) {
  const used = new Set(pipeline.map(step => step.id));
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

function sortedJson(value) {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${sortedJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

/**
 * Steps compared without instance ids and with options resolved against the
 * method defaults, so a pipeline that only omits default values still matches.
 */
function stepsShape(steps, methods) {
  const byId = new Map((methods ?? []).map(method => [method.id, method]));
  return sortedJson(steps.map(step => {
    const method = byId.get(step.method);
    return [step.method, step.enabled !== false, { ...(method?.defaults ?? {}), ...(step.options ?? {}) }, method ? formatOverridesOf(method, step.formats) : (step.formats ?? {})];
  }));
}

function downloadJson(data, filename) {
  const blob = new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function fileSafe(name) {
  return String(name).replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'preset';
}

const MAX_IMPORT_BYTES = 200 * 1024;

function PresetCard({ preset, active, lang, t, disabled, onApply, onExport, onRemove }) {
  const [confirming, setConfirming] = React.useState(false);
  React.useEffect(() => {
    if (!confirming) return undefined;
    const timer = setTimeout(() => setConfirming(false), 4000);
    return () => clearTimeout(timer);
  }, [confirming]);
  return h('div', { className: `cm-preset${active ? ' active' : ''}` },
    h('div', { className: 'cm-row' },
      h('span', { className: 'cm-name cm-grow' }, preset.name?.[lang] ?? preset.id),
      preset.user ? h('span', { className: 'cm-badge' }, t('presetUser')) : null,
      active ? h('span', { className: 'cm-badge brand' }, t('presetActive')) : h('button', { type: 'button', className: 'cm-btn', disabled, onClick: () => onApply(preset) }, t('applyPreset'))),
    preset.summary?.[lang] ? h('div', { className: 'cm-sum' }, preset.summary[lang]) : null,
    h('div', { className: 'cm-row' },
      h('span', { className: 'cm-sum cm-muted cm-grow' }, fmt(t('presetSteps'), { count: preset.steps.length })),
      preset.user ? h('button', { type: 'button', className: 'cm-btn ghost', onClick: () => onExport([preset.id], preset.name?.[lang]) }, t('exportPreset')) : null,
      preset.user ? h('button', {
        type: 'button', className: `cm-btn ghost${confirming ? ' danger' : ''}`, disabled,
        onClick: () => { if (confirming) { setConfirming(false); onRemove(preset.id); } else setConfirming(true); },
      }, confirming ? t('removeConfirm') : t('removePreset')) : null),
    (preset.warnings ?? []).length > 0 ? h('div', { className: 'cm-sum cm-warn' }, preset.warnings.join('; ')) : null);
}

function SavePresetForm({ pipeline, userNames, t, onSave, onCancel }) {
  const [name, setName] = React.useState('');
  const [summary, setSummary] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const trimmed = name.trim();
  const overwrite = userNames.includes(trimmed);
  const submit = async event => {
    event.preventDefault();
    if (!trimmed || busy) return;
    setBusy(true);
    try { await onSave(trimmed, summary.trim()); } finally { setBusy(false); }
  };
  return h('form', { className: 'cm-add', onSubmit: submit },
    h('div', { className: 'cm-fields' },
      h('label', { className: 'cm-field' },
        h('span', null, t('presetName')),
        h('input', { className: 'cm-input', value: name, maxLength: 60, autoFocus: true, onChange: e => setName(e.target.value) }),
        overwrite ? h('small', { className: 'cm-warn' }, t('presetOverwrite')) : null),
      h('label', { className: 'cm-field', style: { gridColumn: 'span 2' } },
        h('span', null, t('presetSummary')),
        h('input', { className: 'cm-input', value: summary, maxLength: 400, onChange: e => setSummary(e.target.value) }))),
    h('div', { className: 'cm-row' },
      h('span', { className: 'cm-sum cm-grow' }, fmt(t('presetSaveHint'), { count: pipeline.length })),
      h('button', { type: 'button', className: 'cm-btn', onClick: onCancel }, t('cancel')),
      h('button', { type: 'submit', className: 'cm-btn primary', disabled: busy || !trimmed || pipeline.length === 0 }, busy ? t('saving') : t('savePreset'))));
}

function PresetBar({ presets, pipeline, methods, lang, t, disabled, userWritable, onApply, onWriteUserPresets }) {
  const current = stepsShape(pipeline, methods);
  const [saving, setSaving] = React.useState(false);
  const [message, setMessage] = React.useState(undefined);
  const fileInput = React.useRef(null);
  const user = presets.filter(preset => preset.user);
  const report = (ok, text, details) => setMessage({ ok, text, details });

  const exportPresets = async (ids, name) => {
    try {
      const data = await callHost('presets/export', ids ? { ids } : {});
      downloadJson(data, ids && ids.length === 1 ? `compaction-preset-${fileSafe(name)}.json` : 'compaction-presets.json');
    } catch (error) { report(false, t('presetFailed') + String(error?.message ?? error)); }
  };
  const remove = async id => {
    try {
      await onWriteUserPresets(user.filter(preset => preset.id !== id).map(preset => ({ id: preset.id, name: preset.name.zh, summary: preset.summary.zh, steps: preset.steps })));
      report(true, t('presetRemoved'));
    } catch (error) { report(false, t('presetFailed') + String(error?.message ?? error)); }
  };
  const save = async (name, summary) => {
    try {
      const result = await callHost('presets/save', { name, summary, steps: pipeline });
      await onWriteUserPresets(result.userPresets);
      setSaving(false);
      report(true, fmt(t(result.replaced ? 'presetReplaced' : 'presetSaved'), { name }), result.warnings);
    } catch (error) { report(false, t('presetFailed') + String(error?.message ?? error)); }
  };
  const importFile = async event => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      if (file.size > MAX_IMPORT_BYTES) throw new Error(fmt(t('importTooLarge'), { size: Math.round(MAX_IMPORT_BYTES / 1024) }));
      const result = await callHost('presets/import', { text: await file.text() });
      if (result.added.length > 0) await onWriteUserPresets(result.userPresets);
      const warnings = result.added.flatMap(item => (item.warnings ?? []).map(warning => `${item.name}: ${warning}`));
      report(result.added.length > 0, fmt(t('importDone'), { count: result.added.length, failed: result.errors.length }), [...result.errors, ...warnings]);
    } catch (error) { report(false, t('presetFailed') + String(error?.message ?? error)); }
  };

  return h('div', { className: 'cm-steps' },
    h('div', { className: 'cm-row' },
      h('span', { className: 'cm-label cm-grow' }, t('presets')),
      h('button', { type: 'button', className: 'cm-btn', disabled: !userWritable || pipeline.length === 0, onClick: () => { setMessage(undefined); setSaving(!saving); } }, t('saveAsPreset')),
      h('button', { type: 'button', className: 'cm-btn', disabled: !userWritable, onClick: () => fileInput.current?.click() }, t('importPresets')),
      h('button', { type: 'button', className: 'cm-btn', disabled: user.length === 0, onClick: () => exportPresets(undefined) }, t('exportAll')),
      h('input', { ref: fileInput, type: 'file', accept: 'application/json,.json', style: { display: 'none' }, onChange: importFile })),
    saving ? h(SavePresetForm, { pipeline, userNames: user.map(preset => preset.name.zh), t, onSave: save, onCancel: () => setSaving(false) }) : null,
    message ? h('div', { className: `cm-msg ${message.ok ? 'ok' : 'err'}` },
      message.text,
      (message.details ?? []).length > 0 ? h('ul', { className: 'cm-sum', style: { margin: '4px 0 0', paddingLeft: 18 } }, message.details.map((line, i) => h('li', { key: i }, line))) : null) : null,
    h('div', { className: 'cm-presets' },
      presets.map(preset => h(PresetCard, {
        key: `${preset.user ? 'u' : 'b'}:${preset.id}`, preset, active: stepsShape(preset.steps, methods) === current, lang, t, disabled,
        onApply, onExport: exportPresets, onRemove: remove,
      }))));
}

function AddStep({ methods, lang, t, disabled, onAdd }) {
  const [choice, setChoice] = React.useState(methods[0]?.id ?? '');
  const method = methods.find(item => item.id === choice);
  return h('div', { className: 'cm-add' },
    h('div', { className: 'cm-row' },
      h('select', { className: 'cm-select cm-grow', 'aria-label': t('addStep'), disabled, value: choice, onChange: e => setChoice(e.target.value) },
        methods.map(item => h('option', { key: item.id, value: item.id }, item.name?.[lang] ?? item.id))),
      h('button', { type: 'button', className: 'cm-btn', disabled: disabled || !method, onClick: () => onAdd(choice) }, t('addStep'))),
    method ? h('div', { className: 'cm-sum' }, method.summary?.[lang]) : null);
}

function PipelineEditor({ pipeline, methods, presets, lang, t, disabled, onChange, onWriteUserPresets }) {
  const byId = new Map(methods.map(method => [method.id, method]));
  const update = (index, patch) => onChange(pipeline.map((step, i) => (i === index ? { ...step, ...patch } : step)));
  const move = (index, delta) => {
    const next = [...pipeline];
    const [item] = next.splice(index, 1);
    next.splice(index + delta, 0, item);
    onChange(next);
  };
  return h('div', { className: 'cm-steps' },
    h(PresetBar, { presets, pipeline, methods, lang, t, disabled, userWritable: !disabled, onApply: preset => onChange(clone(preset.steps)), onWriteUserPresets }),
    h('div', { className: 'cm-label' }, t('steps')),
    pipeline.length === 0 ? h('p', { className: 'cm-hint' }, t('noSteps')) : null,
    pipeline.map((step, index) => h(StepCard, {
      key: step.id, step, index, count: pipeline.length, method: byId.get(step.method), lang, t, disabled,
      onToggle: () => update(index, { enabled: !step.enabled }),
      onMove: delta => move(index, delta),
      onRemove: () => onChange(pipeline.filter((_, i) => i !== index)),
      onOptions: options => update(index, { options }),
      onFormats: formats => update(index, { formats: Object.keys(formats).length > 0 ? formats : undefined }),
    })),
    h(AddStep, { methods, lang, t, disabled, onAdd: id => onChange([...pipeline, { id: uniqueStepId(pipeline, id), method: id, enabled: true, options: {} }]) }),
    h('div', { className: 'cm-step cm-final' },
      h('div', { className: 'cm-step-top' },
        h('div', { className: 'cm-idx' }, '∑'),
        h('div', { className: 'cm-grow' },
          h('div', { className: 'cm-name' }, t('finalStep')),
          h('div', { className: 'cm-sum' }, t('finalStepHint'))))));
}
