// Shared client helpers and styles. Concatenated into dist/client.js by scripts/build.mjs.
const PKG = 'dsh-compaction-manager';
const PANEL_ID = 'compaction-manager';
const ENTRY_ID = 'compaction-manager';

function fmt(text, params) {
  return String(text).replace(/\{(\w+)\}/g, (_, key) => (params && params[key] !== undefined ? String(params[key]) : `{${key}}`));
}

function compact(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '–';
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (Math.abs(n) >= 1e4) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

async function callHost(path, body) {
  const response = await fetch(new URL(`api/compaction-manager/${path}`, document.baseURI), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  let data;
  try { data = await response.json(); } catch { throw new Error(`HTTP ${response.status}`); }
  if (!data || data.ok !== true) throw new Error(data?.error ?? `HTTP ${response.status}`);
  return data.value;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

const CSS = `
.cm-page{height:100%;overflow:auto;color:var(--dsw-alias-label-primary);font-size:14px;line-height:1.5}
.cm-inner{max-width:920px;margin:0 auto;padding:28px 24px 64px;display:flex;flex-direction:column;gap:20px}
.cm-head h1{font-size:20px;font-weight:600;margin:0 0 4px}
.cm-sub{color:var(--dsw-alias-label-secondary);margin:0}
.cm-section{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:16px 18px;background:var(--dsw-alias-bg-layer-1)}
.cm-section h2{font-size:15px;font-weight:600;margin:0 0 4px;display:flex;align-items:center;gap:8px}
.cm-hint{color:var(--dsw-alias-label-tertiary);font-size:12.5px;margin:0 0 12px}
.cm-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.cm-grow{flex:1;min-width:0}
.cm-status{display:flex;gap:16px;flex-wrap:wrap;font-size:12.5px;color:var(--dsw-alias-label-secondary)}
.cm-dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:5px;background:var(--dsw-alias-label-tertiary)}
.cm-dot.on{background:var(--dsw-alias-state-success-primary)}
.cm-steps{display:flex;flex-direction:column;gap:8px}
.cm-step{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-base)}
.cm-step.off{opacity:.72}
.cm-step-top{display:flex;align-items:center;gap:10px;padding:10px 12px}
.cm-idx{width:22px;height:22px;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);flex:none}
.cm-name{font-weight:600}
.cm-sum{color:var(--dsw-alias-label-secondary);font-size:12.5px;margin-top:2px}
.cm-badge{font-size:11px;padding:1px 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.cm-badge.brand{color:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary)}
.cm-badge.warn{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
.cm-body{border-top:1px solid var(--dsw-alias-border-l1);padding:12px 14px 14px 44px;display:flex;flex-direction:column;gap:12px}
.cm-details{white-space:pre-wrap;font-size:12.5px;color:var(--dsw-alias-label-secondary);margin:0}
.cm-fields{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px 14px}
.cm-field{display:flex;flex-direction:column;gap:4px;font-size:12.5px}
.cm-field>span{color:var(--dsw-alias-label-secondary)}
.cm-field small{color:var(--dsw-alias-label-tertiary)}
.cm-input,.cm-select,.cm-textarea{font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l3);border-radius:8px;padding:6px 9px;outline:none;min-width:0}
.cm-input:focus,.cm-select:focus,.cm-textarea:focus{border-color:var(--dsw-alias-state-business-primary)}
.cm-input.bad{border-color:var(--dsw-alias-state-error-primary)}
.cm-textarea{min-height:72px;resize:vertical;font-family:var(--dsw-font-mono,ui-monospace,monospace)}
.cm-btn{font:inherit;font-size:13px;border:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);border-radius:8px;padding:5px 12px;cursor:pointer;white-space:nowrap}
.cm-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.cm-btn:disabled{opacity:.45;cursor:default}
.cm-btn.primary{background:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary-foreground,#fff)}
.cm-btn.primary:hover:not(:disabled){filter:brightness(1.08);background:var(--dsw-alias-state-business-primary)}
.cm-btn.ghost{border-color:transparent;background:transparent;color:var(--dsw-alias-label-secondary);padding:3px 7px}
.cm-btn.ghost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.cm-switch{position:relative;width:34px;height:20px;border-radius:10px;border:0;background:var(--dsw-alias-border-l4);cursor:pointer;flex:none;padding:0}
.cm-switch[aria-checked=true]{background:var(--dsw-alias-state-business-primary)}
.cm-switch::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:left .15s}
.cm-switch[aria-checked=true]::after{left:16px}
.cm-switch:disabled{opacity:.45;cursor:default}
.cm-final{border-style:dashed}
.cm-label{font-size:12px;font-weight:600;color:var(--dsw-alias-label-tertiary);text-transform:uppercase;letter-spacing:.04em;margin-top:6px}
.cm-presets{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:8px}
.cm-preset{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:10px 12px;background:var(--dsw-alias-bg-base);display:flex;flex-direction:column;gap:4px}
.cm-preset.active{border-color:var(--dsw-alias-state-business-primary)}
.cm-add{border:1px dashed var(--dsw-alias-border-l3);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:6px}
.cm-bar{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}
.cm-msg{font-size:12.5px;color:var(--dsw-alias-label-secondary)}
.cm-msg.err{color:var(--dsw-alias-state-error-primary)}
.cm-msg.ok{color:var(--dsw-alias-state-success-primary)}
.cm-radio{display:flex;flex-direction:column;gap:6px;font-size:13px}
.cm-radio label{display:flex;gap:8px;align-items:center;cursor:pointer}
.cm-total{display:flex;gap:12px;align-items:baseline;flex-wrap:wrap;margin:10px 0}
.cm-total b{font-size:18px}
.cm-meter{height:8px;border-radius:4px;background:var(--dsw-alias-bg-layer-3);overflow:hidden;margin:4px 0 12px}
.cm-meter>div{height:100%;background:var(--dsw-alias-state-business-primary)}
.cm-pstep{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;margin-top:8px;background:var(--dsw-alias-bg-base)}
.cm-pstep>header{display:flex;gap:10px;align-items:center;padding:8px 12px;cursor:pointer}
.cm-items{border-top:1px solid var(--dsw-alias-border-l1);display:flex;flex-direction:column}
.cm-item{padding:7px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:12.5px}
.cm-item:last-child{border-bottom:0}
.cm-diff{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px}
.cm-diff>div{min-width:0}
.cm-diff pre{margin:2px 0 0;max-height:320px;overflow:auto;white-space:pre-wrap;word-break:break-word;font-size:11.5px;padding:8px;border-radius:8px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1)}
.cm-mono{font-family:var(--dsw-font-mono,ui-monospace,monospace)}
.cm-muted{color:var(--dsw-alias-label-tertiary)}
@media (max-width:720px){.cm-diff{grid-template-columns:1fr}.cm-body{padding-left:14px}}
`;
