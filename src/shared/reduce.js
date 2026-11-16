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
    if (ev.type === 'context') { msg.ctxChars = ev.chars; return; }
    if (ev.type === 'status') {
      msg.status = ev.status; if (ev.error) msg.error = ev.error; if (ev.meta) msg.meta = ev.meta;
      // 對話模式下 Agent 想改檔：畫面依此顯示「切到工作模式並繼續」
      if (ev.needWork) msg.needWork = ev.needWork;
      cleanMark(msg.parts);
      return;
    }
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

  // 對話模式（唯讀）下，Agent 需要改檔時在回覆最後另起一行寫這個標記（見 mode.js 的說明）；
  // 主程序據此讓畫面出現切換按鈕，標記本身不顯示、也不留在存檔裡。
  const MARK = '[[agentdesk:work]]';
  // live：還在串流時，連結尾「打到一半的標記」也先藏起來，免得閃一下
  function stripMark(text, live) {
    let s = String(text || '');
    if (s.includes(MARK)) return s.split(MARK).join('').replace(/\s+$/, '');
    if (live) for (let n = MARK.length - 1; n >= 2; n--) if (s.endsWith(MARK.slice(0, n))) return s.slice(0, -n);
    return s;
  }
  function cleanMark(parts) {
    for (const p of parts || []) {
      if (p.kind === 'text') p.text = stripMark(p.text);
      else if (p.kind === 'delegate') cleanMark(p.parts);
    }
  }
  // 訊息裡所有文字（含委派卡片內的）
  function partsText(parts) {
    return (parts || []).map(p => (p.kind === 'text' ? p.text : p.kind === 'delegate' ? partsText(p.parts) : '')).join('\n');
  }

  const api = { applyEvent, MARK, stripMark, partsText };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Reduce = api;
})(this);
