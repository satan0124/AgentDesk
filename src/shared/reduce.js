// 主程序與畫面共用：把 Agent 事件套進 assistant 訊息的 parts。
(function (root) {
  function targetParts(msg, ev) {
    if (!ev.del) return msg.parts;
    const d = msg.parts.find(p => p.kind === 'delegate' && p.id === ev.del);
    return d ? d.parts : msg.parts;
  }

  function applyEvent(msg, ev) {
    if (ev.type === 'delegate_start') {
      msg.parts.push({ kind: 'delegate', id: ev.id, agent: ev.agent, prompt: ev.prompt, status: 'running', parts: [] });
      return;
    }
    if (ev.type === 'delegate_end') {
      const d = msg.parts.find(p => p.kind === 'delegate' && p.id === ev.id);
      if (d) { d.status = ev.error ? (ev.error === '已停止' ? 'stopped' : 'error') : 'done'; d.error = ev.error; }
      return;
    }
    if (ev.type === 'status') { msg.status = ev.status; if (ev.error) msg.error = ev.error; if (ev.meta) msg.meta = ev.meta; return; }
    const parts = targetParts(msg, ev);
    const last = parts[parts.length - 1];
    if (ev.type === 'text') {
      if (last && last.kind === 'text') last.text += ev.text;
      else if (ev.text && ev.text.trim()) parts.push({ kind: 'text', text: ev.text.replace(/^\s+/, '') });
    } else if (ev.type === 'thinking') {
      if (last && last.kind === 'thinking') last.text += ev.text;
      else parts.push({ kind: 'thinking', text: ev.text });
    } else if (ev.type === 'tool') {
      const found = ev.id && parts.find(p => p.kind === 'tool' && p.id === ev.id);
      if (found) {
        for (const k of ['name', 'detail', 'status', 'output']) if (ev[k] !== undefined) found[k] = ev[k];
      } else parts.push({ kind: 'tool', id: ev.id, name: ev.name || 'tool', detail: ev.detail || '', status: ev.status, output: ev.output });
    } else if (ev.type === 'notice') {
      parts.push({ kind: 'notice', text: ev.text });
    }
  }

  const api = { applyEvent };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Reduce = api;
})(this);
