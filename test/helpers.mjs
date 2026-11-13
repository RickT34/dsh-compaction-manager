// DSH packages resolve through node_modules; run `npm run link-dsh` once to
// link them from the local DeepSeek Harness installation.
export const { Session, SessionId, foldSurface, deriveEventMessage } = await import('@deepseek-ai/dsh-session');
export const { ToolResultPruner } = await import('@deepseek-ai/dsh-compaction-tool-result-pruner');

export const meter = { estimateMessage: m => Math.ceil(JSON.stringify(m.content).length / 4) + 4 };

let n = 0;
const id = () => `m${++n}`;

/** Build a session with `turns` of tool use. spec: [{ name, args, result, error }] per turn. */
export function makeSession(turns) {
  const s = Session.create(SessionId('test-session'));
  s.append('system/message', { turn: 1, step: 1, message: { role: 'system', content: [{ type: 'text', text: 'sys' }], source: { kind: 'system-prompt' }, id: id() } }, { surfaceOp: 'append' });
  let t = 0;
  for (const calls of turns) {
    t += 1;
    s.append('turn/start', { turn: t });
    s.append('user/message', { role: 'user', content: [{ type: 'text', text: `task ${t}` }], source: { kind: 'user' }, id: id() }, { surfaceOp: 'append' });
    s.append('step/start', { turn: t, step: 1 });
    const blocks = [{ type: 'text', text: `working on ${t}` }, ...calls.map((c, i) => ({ type: 'tool-call', id: `call-${t}-${i}`, name: c.name, arguments: JSON.stringify(c.args) }))];
    s.append('assistant/message', { turn: t, step: 1, message: { role: 'assistant', content: blocks, source: { kind: 'model', provider: 'p', model: 'm' }, id: id() }, stream: [] }, { surfaceOp: 'append' });
    calls.forEach((c, i) => {
      s.append('tool/call', { turn: t, step: 1, callId: `call-${t}-${i}`, name: c.name, arguments: JSON.stringify(c.args) });
      const message = { id: id(), role: 'tool', source: { kind: 'tool', callId: `call-${t}-${i}` }, toolCallId: `call-${t}-${i}`, content: [{ type: 'text', text: c.result }], ...(c.error ? { isError: true } : {}) };
      s.append('tool/result', { turn: t, step: 1, message }, { surfaceOp: 'append' });
    });
    s.append('step/end', { turn: t, step: 1 });
    s.append('step/start', { turn: t, step: 2 });
    s.append('assistant/message', { turn: t, step: 2, message: { role: 'assistant', content: [{ type: 'text', text: `done ${t}` }], source: { kind: 'model', provider: 'p', model: 'm' }, id: id() }, stream: [] }, { surfaceOp: 'append' });
    s.append('step/end', { turn: t, step: 2 });
    s.append('turn/end', { turn: t, reason: { kind: 'completed' } });
  }
  return s;
}

/** A ToolResultPruner instance without a Cordis context. */
export function bareP(config = {}) {
  const p = Object.create(ToolResultPruner.prototype);
  p.ctx = { tokenMeter: meter };
  p.config = { thresholdChars: 8192, headChars: 4096, tailChars: 1024, ...config };
  return p;
}
