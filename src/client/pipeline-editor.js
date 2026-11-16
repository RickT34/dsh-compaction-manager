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

function StepCard({ step, index, count, method, lang, t, disabled, onToggle, onMove, onRemove, onOptions }) {
  const [open, setOpen] = React.useState(false);
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
          missing ? h('span', { className: 'cm-badge warn' }, t('missingMethod')) : h('span', { className: 'cm-badge' }, recall ? t('recallYes') : t('recallNo'))),
        tag ? h('div', { className: 'cm-sum cm-mono' }, tag) : null,
        method ? h('div', { className: 'cm-sum' }, method.summary?.[lang]) : null),
      h('button', { type: 'button', className: 'cm-btn ghost', title: t('moveUp'), 'aria-label': t('moveUp'), disabled: disabled || index === 0, onClick: () => onMove(-1) }, '↑'),
      h('button', { type: 'button', className: 'cm-btn ghost', title: t('moveDown'), 'aria-label': t('moveDown'), disabled: disabled || index === count - 1, onClick: () => onMove(1) }, '↓'),
      method ? h('button', { type: 'button', className: 'cm-btn ghost', 'aria-expanded': open, onClick: () => setOpen(!open) }, open ? t('hideDetails') : t('details')) : null,
      h('button', { type: 'button', className: 'cm-btn ghost', title: t('removeStep'), 'aria-label': `${t('removeStep')}: ${name}`, disabled, onClick: onRemove }, '✕'),
      h('button', { type: 'button', role: 'switch', 'aria-checked': step.enabled, 'aria-label': `${t('enabled')}: ${name}`, className: 'cm-switch', disabled: disabled || missing, onClick: onToggle })),
    open && method ? h('div', { className: 'cm-body' },
      h('p', { className: 'cm-details' }, method.details?.[lang]),
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
      Object.keys(options).length > 0 ? h('div', null, h('button', { type: 'button', className: 'cm-btn', disabled, onClick: () => onOptions({}) }, t('resetOptions'))) : null) : null);
}

function uniqueStepId(pipeline, base) {
  const used = new Set(pipeline.map(step => step.id));
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

/** Steps compared without instance ids, for matching a pipeline to a preset. */
function stepsShape(steps) {
  return JSON.stringify(steps.map(step => [step.method, step.enabled !== false, step.options ?? {}]));
}

function PresetBar({ presets, pipeline, lang, t, disabled, onApply }) {
  const current = stepsShape(pipeline);
  return h('div', { className: 'cm-presets' },
    presets.map(preset => {
      const active = stepsShape(preset.steps) === current;
      return h('div', { key: preset.id, className: `cm-preset${active ? ' active' : ''}` },
        h('div', { className: 'cm-row' },
          h('span', { className: 'cm-name cm-grow' }, preset.name?.[lang] ?? preset.id),
          active ? h('span', { className: 'cm-badge brand' }, t('presetActive')) : h('button', { type: 'button', className: 'cm-btn', disabled, onClick: () => onApply(preset) }, t('applyPreset'))),
        h('div', { className: 'cm-sum' }, preset.summary?.[lang]),
        h('div', { className: 'cm-sum cm-muted' }, fmt(t('presetSteps'), { count: preset.steps.length })));
    }));
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

function PipelineEditor({ pipeline, methods, presets, lang, t, disabled, onChange }) {
  const byId = new Map(methods.map(method => [method.id, method]));
  const update = (index, patch) => onChange(pipeline.map((step, i) => (i === index ? { ...step, ...patch } : step)));
  const move = (index, delta) => {
    const next = [...pipeline];
    const [item] = next.splice(index, 1);
    next.splice(index + delta, 0, item);
    onChange(next);
  };
  return h('div', { className: 'cm-steps' },
    h('div', { className: 'cm-label' }, t('presets')),
    h(PresetBar, { presets, pipeline, lang, t, disabled, onApply: preset => onChange(clone(preset.steps)) }),
    h('div', { className: 'cm-label' }, t('steps')),
    pipeline.length === 0 ? h('p', { className: 'cm-hint' }, t('noSteps')) : null,
    pipeline.map((step, index) => h(StepCard, {
      key: step.id, step, index, count: pipeline.length, method: byId.get(step.method), lang, t, disabled,
      onToggle: () => update(index, { enabled: !step.enabled }),
      onMove: delta => move(index, delta),
      onRemove: () => onChange(pipeline.filter((_, i) => i !== index)),
      onOptions: options => update(index, { options }),
    })),
    h(AddStep, { methods, lang, t, disabled, onAdd: id => onChange([...pipeline, { id: uniqueStepId(pipeline, id), method: id, enabled: true, options: {} }]) }),
    h('div', { className: 'cm-step cm-final' },
      h('div', { className: 'cm-step-top' },
        h('div', { className: 'cm-idx' }, '∑'),
        h('div', { className: 'cm-grow' },
          h('div', { className: 'cm-name' }, t('finalStep')),
          h('div', { className: 'cm-sum' }, t('finalStepHint'))))));
}
