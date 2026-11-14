// Page, icons, and client apply.
function useStore(subscribe, read) {
  return React.useSyncExternalStore(subscribe, read, read);
}

function makeT(ctx) {
  const bound = ctx.locale.bind(NS);
  return key => {
    const value = bound(key);
    return typeof value === 'string' && value !== key && value !== `${NS}.${key}` ? value : (en[key] ?? key);
  };
}

function langOf(ctx) {
  const active = String(ctx.locale.getLocale?.().active ?? ctx.locale.getSnapshot?.().active ?? 'en');
  return active.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

function CompactIcon({ size = 18 }) {
  return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
    h('path', { d: 'M4 5h16M4 19h16' }),
    h('path', { d: 'M8.5 8.5l3.5 2.5 3.5-2.5M8.5 15.5l3.5-2.5 3.5 2.5' }));
}

function StatusLine({ state, t }) {
  const item = (on, label, text) => h('span', null, h('span', { className: `cm-dot${on ? ' on' : ''}` }), `${label}: ${text}`);
  return h('div', { className: 'cm-status' },
    item(state.integration?.pruner, t('statusPruner'), state.integration?.pruner ? t('on') : t('off')),
    item(state.integration?.basic, t('statusBasic'), state.integration?.basic ? t('on') : t('off')),
    item(state.recallActive, t('statusRecall'), state.recallActive ? t('active') : t('inactive')),
    h('span', null, `${t('prunerCalls')}: ${state.stats?.prunerCalls ?? 0}`));
}

function CompactionPage({ ctx, form }) {
  useStore(cb => ctx.locale.subscribe(cb), () => ctx.locale.getSnapshot?.().revision ?? langOf(ctx));
  const t = makeT(ctx);
  const lang = langOf(ctx);
  const snap = useStore(cb => form.subscribe(cb), () => form.getSnapshot());
  const [state, setState] = React.useState(undefined);
  const [loadError, setLoadError] = React.useState('');
  const [draft, setDraft] = React.useState(undefined);
  const [message, setMessage] = React.useState(undefined);
  const [saving, setSaving] = React.useState(false);

  const load = React.useCallback(() => {
    setLoadError('');
    callHost('state').then(setState, e => setLoadError(String(e.message ?? e)));
  }, []);
  React.useEffect(load, [load]);

  if (loadError) return h('div', { className: 'cm-page' }, h('div', { className: 'cm-inner' }, h('p', { className: 'cm-msg err' }, t('loadFailed') + loadError), h('div', null, h('button', { type: 'button', className: 'cm-btn', onClick: load }, t('retry')))));
  if (state === undefined) return h('div', { className: 'cm-page' }, h('div', { className: 'cm-inner cm-muted' }, t('loading')));

  const saved = { pipeline: state.pipeline, basic: state.basic ?? {}, recall: state.recall ?? 'auto' };
  const defaultFull = state.defaultPipeline.map(step => ({ method: step.method, enabled: step.enabled, options: {} }))
    .concat(state.methods.filter(m => !state.defaultPipeline.some(s => s.method === m.id)).map(m => ({ method: m.id, enabled: false, options: {} })));
  const current = draft ?? saved;
  const dirty = draft !== undefined && !sameJson(draft, saved);
  const writable = snap.status === 'ready' && snap.writable;
  const edit = patch => { setMessage(undefined); setDraft({ ...clone(current), ...patch }); };

  const save = async () => {
    setSaving(true);
    setMessage(undefined);
    try {
      await callHost('validate', { basic: current.basic });
      const ops = [];
      const isDefaultPipeline = sameJson(current.pipeline, defaultFull);
      ops.push(isDefaultPipeline ? { op: 'unset', path: ['pipeline'] } : { op: 'set', path: ['pipeline'], value: current.pipeline });
      ops.push(Object.keys(current.basic).length === 0 ? { op: 'unset', path: ['basic'] } : { op: 'set', path: ['basic'], value: current.basic });
      ops.push(current.recall === 'auto' ? { op: 'unset', path: ['recall'] } : { op: 'set', path: ['recall'], value: current.recall });
      const ok = await form.mutate(ops, snap.revision);
      if (!ok) throw new Error(t('notServed'));
      setDraft(undefined);
      setMessage({ ok: true, text: t('saved') });
      setTimeout(load, 300);
    } catch (error) {
      setMessage({ ok: false, text: t('saveFailed') + String(error?.message ?? error) });
    } finally {
      setSaving(false);
    }
  };

  const effectiveBasic = state.basicConfigs?.[0];
  return h('div', { className: 'cm-page' },
    h('style', null, CSS),
    h('div', { className: 'cm-inner' },
      h('header', { className: 'cm-head' }, h('h1', null, t('title')), h('p', { className: 'cm-sub' }, t('subtitle'))),
      h(StatusLine, { state, t }),
      !writable ? h('p', { className: 'cm-msg' }, snap.status === 'ready' ? t('readOnly') : t('notServed')) : null,
      dirty || message ? h('div', { className: 'cm-bar' },
        h('span', { className: `cm-msg cm-grow${message ? (message.ok ? ' ok' : ' err') : ''}` }, message ? message.text : t('unsaved')),
        dirty ? h('button', { type: 'button', className: 'cm-btn', disabled: saving, onClick: () => { setDraft(undefined); setMessage(undefined); } }, t('discard')) : null,
        dirty ? h('button', { type: 'button', className: 'cm-btn primary', disabled: saving || !writable, onClick: save }, saving ? t('saving') : t('save')) : null) : null,
      h('section', { className: 'cm-section' },
        h('h2', null, t('sectionPipeline')),
        h('p', { className: 'cm-hint' }, t('pipelineHint')),
        h(PipelineEditor, {
          pipeline: current.pipeline, methods: state.methods, lang, t, disabled: !writable,
          onChange: pipeline => edit({ pipeline }),
          onReset: () => edit({ pipeline: clone(defaultFull) }),
        })),
      h('section', { className: 'cm-section' },
        h('h2', null, t('sectionBasic')),
        h('p', { className: 'cm-hint' }, t('basicHint')),
        h(BasicForm, { basic: current.basic, effective: effectiveBasic, t, disabled: !writable, onChange: basic => edit({ basic }) })),
      h('section', { className: 'cm-section' },
        h('h2', null, t('sectionRecall')),
        h('p', { className: 'cm-hint' }, t('recallHint')),
        h(RecallChooser, { value: current.recall, t, disabled: !writable, onChange: recall => edit({ recall }) })),
      h('section', { className: 'cm-section' },
        h('h2', null, t('sectionPreview')),
        h('p', { className: 'cm-hint' }, t('previewMoved'))),
      h('section', { className: 'cm-section' },
        h('h2', null, t('recentRuns')),
        (state.stats?.runs ?? []).length === 0 ? h('p', { className: 'cm-hint' }, t('noRuns')) : h('div', { className: 'cm-items' },
          state.stats.runs.map((run, index) => h('div', { key: index, className: 'cm-item' },
            h('span', { className: 'cm-muted' }, new Date(run.at).toLocaleString()), ' · ',
            h('span', { className: 'cm-mono' }, run.sessionId), ' · ',
            run.steps.map(step => `${step.method}: ${step.applied}`).join(', '),
            ` · −${compact(run.tokensSaved)} tokens`))))));
}

function PluginCard({ ctx, view }) {
  useStore(cb => ctx.locale.subscribe(cb), () => ctx.locale.getSnapshot?.().revision ?? langOf(ctx));
  const t = makeT(ctx);
  if (view === 'summary') return t('pluginSummary');
  const layout = ctx.get('layout');
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-start' } },
    h('p', { className: 'cm-sub', style: { margin: 0, color: 'var(--dsw-alias-label-secondary)' } }, t('subtitle')),
    h('button', {
      type: 'button',
      style: { font: 'inherit', fontSize: 13, border: '1px solid var(--dsw-alias-state-business-primary)', background: 'var(--dsw-alias-state-business-primary)', color: 'var(--dsw-alias-label-primary-foreground, #fff)', borderRadius: 8, padding: '6px 14px', cursor: 'pointer' },
      disabled: layout === undefined,
      onClick: () => { try { layout?.selectPanel(PANEL_ID); } catch { /* panel not registered */ } },
    }, t('open')));
}

const inject = ['slots', 'locale', 'configForms'];

function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'compaction-manager: dictionaries');
  const form = ctx.configForms.get(ENTRY_ID);
  const Page = () => h(CompactionPage, { ctx, form });
  const Card = props => h(PluginCard, { ctx, view: props?.view });
  ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, Page)), 'compaction-manager: main panel');
  ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: PANEL_ID, order: 40, locale: NS, label: () => makeT(ctx)('title'),
  }, props => h(CompactIcon, { size: typeof props?.size === 'number' ? props.size : 18 }))), 'compaction-manager: sidebar entry');
  const View = props => h(SessionCompactionView, { ctx, sessionId: props?.sessionId });
  ctx.effect(() => ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view', id: PANEL_ID, order: 40, locale: NS, label: () => makeT(ctx)('viewTab'),
    inject: sessionId => ({ sessionId }),
  }, View)), 'compaction-manager: conversation view');
  ctx.effect(() => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({ name: 'plugins.bundle.config', key: PKG, locale: NS }, Card)), 'compaction-manager: plugins page card');
}
