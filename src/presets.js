// Presets: named combinations of atomic steps. Applying one replaces the
// pipeline; the result stays editable. Also migrates 0.1.x pipelines, whose
// methods were the presets themselves.
import { PROTECTED_TOOLS } from './methods.js';

const t = (zh, en) => ({ zh, en });
const step = (id, method, options = {}, enabled = true) => ({ id, method, enabled, options });

const RELOADABLE = ['read', 'read_image', 'skill', 'web_fetch'];
const DELEGATED = ['subagent', 'subagent_fork', 'job_output', 'workflow', 'send_message'];

/** Default pipeline: the official pruner alone, with the preset's own pruner config. */
export const DEFAULT_PIPELINE = [step('trim', 'trim-head-tail')];

export const BUILTIN_PRESETS = [
  {
    id: 'official',
    builtin: true,
    name: t('官方默认', 'Official default'),
    summary: t(
      '只做 DSH 原版的首尾裁剪，行为与不装本插件时一致。',
      'Only the stock DSH head/tail trim; behaves as if this plugin were not installed.',
    ),
    steps: DEFAULT_PIPELINE,
  },
  {
    id: 'magic-compact',
    builtin: true,
    name: t('Magic Compact', 'Magic Compact'),
    summary: t(
      '仿照 aerovato/magic-compact 的 /magic-trim 规则：可重新获取的输出超过 200 字符、子代理与任务输出超过 4096 字符、其他输出超过 1024 字符或 128 个词时省略，保留最近 3 个结果和出错的结果；最后用首尾裁剪兜底。原版用模型总结旧回合的部分不实现。',
      'After aerovato/magic-compact /magic-trim: omits reloadable outputs over 200 chars, subagent and job outputs over 4096 chars, and other outputs over 1024 chars or 128 words, keeping the newest 3 and failed results; head/tail trim runs last as a safety net. The original’s model-written turn summaries are not implemented.',
    ),
    steps: [
      step('reloadable', 'omit-output', { tools: RELOADABLE, minChars: 200 }),
      step('delegated', 'omit-output', { tools: DELEGATED, minChars: 4096 }),
      step('other', 'omit-output', { excludeTools: [...PROTECTED_TOOLS, ...RELOADABLE, ...DELEGATED], minChars: 1024, minWords: 128 }),
      step('trim', 'trim-head-tail'),
    ],
  },
  {
    id: 'opencode-dcp',
    builtin: true,
    name: t('OpenCode DCP', 'OpenCode DCP'),
    summary: t(
      '仿照 Opencode-DCP 的自动策略：重复调用去重、4 个回合前全部出错的调用清掉输入；清理被覆盖的读取默认关闭；最后用首尾裁剪兜底。原版让模型调用的 compress 工具不实现。',
      'After Opencode-DCP automatic strategies: deduplicates calls and purges inputs of calls that all failed over 4 turns ago; dropping superseded reads is included but off; head/tail trim runs last. The model-invoked compress tool is not implemented.',
    ),
    steps: [
      step('dedupe', 'dedupe'),
      step('superseded', 'drop-superseded-reads', {}, false),
      step('errors', 'purge-errors'),
      step('trim', 'trim-head-tail'),
    ],
  },
  {
    id: 'aggressive',
    builtin: true,
    name: t('激进', 'Aggressive'),
    summary: t(
      '去重、清理出错调用后，参数加结果超过 4096 字符的旧调用折叠成摘要（保留关键参数、状态和结果开头），其余参数超过 1024 字符的旧调用只保留 description，最后首尾裁剪。模型之后需要细节时要调用 restore_context。',
      'After deduplication and purging failed calls, older calls over 4096 chars of arguments plus results fold to a summary (key arguments, status, result head), remaining older calls with arguments over 1024 chars keep only their descriptions, then head/tail trim. The model must call restore_context for details.',
    ),
    steps: [
      step('dedupe', 'dedupe'),
      step('errors', 'purge-errors'),
      step('summary', 'fold-calls', { detail: 'summary', minTotalChars: 4096, minArgsChars: 0 }),
      step('description', 'fold-calls', { detail: 'description', minTotalChars: 0, minArgsChars: 1024 }),
      step('trim', 'trim-head-tail'),
    ],
  },
];

// ---------------------------------------------------------------- 0.1.x migration

function pick(source, keys) {
  const out = {};
  for (const [from, to] of keys) if (source?.[from] !== undefined) out[to ?? from] = source[from];
  return out;
}

/**
 * Expand one 0.1.x step into atomic steps. Disabled legacy steps are dropped:
 * the old panel listed every method, so they were placeholders, not choices.
 * @returns atomic steps, or undefined when `raw.method` is not a legacy id.
 */
export function migrateLegacyStep(raw) {
  const options = raw.options ?? {};
  const enabled = raw.enabled === true;
  switch (raw.method) {
    case 'official-pruner':
      return enabled ? [step('trim', 'trim-head-tail', pick(options, [['thresholdChars'], ['headChars'], ['tailChars'], ['recallHint']]))] : [];
    case 'magic-compact': {
      if (!enabled) return [];
      const always = options.alwaysTools ?? RELOADABLE;
      const high = options.highTools ?? DELEGATED;
      const preserve = options.preserveTools ?? [...PROTECTED_TOOLS];
      const shared = { ...pick(options, [['keepRecent'], ['previewChars']]), excludeTools: preserve };
      return [
        step('reloadable', 'omit-output', { ...shared, tools: always, minChars: options.minChars ?? 200 }),
        step('delegated', 'omit-output', { ...shared, tools: high, minChars: options.highChars ?? 4096 }),
        step('other', 'omit-output', { ...shared, excludeTools: [...preserve, ...always, ...high], minChars: options.maxChars ?? 1024, minWords: options.maxWords ?? 128 }),
      ];
    }
    case 'opencode-dcp': {
      if (!enabled) return [];
      const shared = { ...pick(options, [['keepRecent']]), ...(options.protectedTools ? { excludeTools: options.protectedTools } : {}) };
      const out = [];
      if (options.dedupe !== false) out.push(step('dedupe', 'dedupe', { ...shared, ...pick(options, [['minChars']]) }));
      if (options.supersededReads === true) out.push(step('superseded', 'drop-superseded-reads', pick(options, [['keepRecent'], ['minChars']])));
      if (options.purgeErrors !== false) out.push(step('errors', 'purge-errors', { ...shared, ...pick(options, [['errorTurns']]) }));
      return out;
    }
    case 'fold-tool-calls':
      return enabled ? [step('fold', 'fold-calls', {
        detail: 'summary',
        ...pick(options, [['minArgsChars'], ['minResultChars', 'minTotalChars'], ['keepRecentGroups'], ['assistantTextChars']]),
        ...(options.protectedTools ? { excludeTools: options.protectedTools } : {}),
      })] : [];
    case 'description-only':
      return enabled ? [step('description', 'fold-calls', {
        detail: 'description', minArgsChars: 0,
        ...pick(options, [['thresholdChars', 'minTotalChars'], ['keepRecentGroups'], ['assistantTextChars']]),
        ...(options.protectedTools ? { excludeTools: options.protectedTools } : {}),
      })] : [];
    default:
      return undefined;
  }
}

