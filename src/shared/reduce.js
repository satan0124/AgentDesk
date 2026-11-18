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
      if (d) { d.status = ev.error ? (ev.error === '已停止' ? 'stopped' : 'error') : 'done'; d.error = ev.error; if (ev.usage) d.usage = ev.usage; }
      return;
    }
    if (ev.type === 'context') { msg.ctxChars = ev.chars; return; }
    if (ev.type === 'status') {
      msg.status = ev.status; if (ev.error) msg.error = ev.error; if (ev.meta) msg.meta = ev.meta;
      if (ev.choices) msg.choices = ev.choices;   // 回覆最後給使用者選的回答（按鈕、輸入框的建議回覆）
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
      if (ev.sub || ev.subError) {
        if (!found) return;
        if (ev.sub) { found.subSteps = (found.subSteps || 0) + 1; found.subLast = `${ev.sub.name} ${ev.sub.detail || ''}`.trim().slice(0, 300); }
        if (ev.subError) found.subErrors = (found.subErrors || 0) + 1;
        return;
      }
      if (found) {
        for (const k of ['name', 'detail', 'status', 'output']) if (ev[k] !== undefined) found[k] = ev[k];
      } else parts.push({ kind: 'tool', id: ev.id, name: ev.name || 'tool', detail: ev.detail || '', status: ev.status, output: ev.output });
    } else if (ev.type === 'approval') {
      // 執行中逐項核准：等使用者按的卡片（pending）→ allowed／denied
      const found = parts.find(p => p.kind === 'approval' && p.id === ev.id);
      if (found) found.status = ev.status;
      else parts.push({ kind: 'approval', id: ev.id, tool: ev.tool, detail: ev.detail || '', status: ev.status });
    } else if (ev.type === 'notice') {
      parts.push({ kind: 'notice', text: ev.text });
    }
  }

  // 對話模式（唯讀）下，Agent 需要改檔時在回覆最後另起一行寫這個標記（見 mode.js 的說明）；
  // 主程序據此讓畫面出現切換按鈕，標記本身不顯示、也不留在存檔裡。
  const MARK = '[[agentdesk:work]]';
  // 跟索引行一樣只認行首的標記（前面可以有空白、條列、粗體）：回覆內文提到這個標記（例如解釋程式碼）不算要改檔，也不能被拿掉
  const MARK_AT = /^([ \t>*_`-]*)\[\[agentdesk:work\]\][`*_]*/gm;
  const hasMark = text => new RegExp(MARK_AT.source, 'm').test(String(text || ''));
  // 每輪回覆最後那一行索引（邊對話邊記，見 compress.js 的 noteAsk）：主程序在回合結束時取出存到訊息上，這一行同樣不顯示、不留在存檔裡
  const NOTE = '[[agentdesk:index]]';
  // 只認行首的標記（前面可以有空白、條列、粗體）：回覆內文提到這個標記（例如解釋程式碼時）不能被當成索引行拿掉
  // 標記單獨一行、內容寫在下一行（2026-11 實測 Cursor 會這樣寫）：下一行有「｜」就一起拿掉（同 compress.js 的 parseNote）
  const NOTE_LINE = /^[ \t>*_`-]*\[\[agentdesk:index\]\](?:[ \t`*_:：]*\r?\n[ \t]*(?=[^\n]*[｜|])[^\n]*|[^\n]*)\n?/gm;
  const NOTE_AT = /^[ \t>*_`-]*\[\[agentdesk:index\]\]/m;
  // 回覆最後給使用者選的回答（見 mode.js 的 choiceNote）：主程序在回合結束時取出存到訊息上（msg.choices），畫面變成按鈕；這一行一樣不顯示
  const CHOICES = '[[agentdesk:choices]]';
  const CHOICE_LINE = /^[ \t>*_`-]*\[\[agentdesk:choices\]\](?:[ \t`*_:：]*\r?\n[ \t]*(?=[^\n]*[｜|])[^\n]*|[^\n]*)\n?/gm;
  const CHOICE_AT = /^[ \t>*_`-]*\[\[agentdesk:choices\]\]/m;
  // live：還在串流時，連結尾「打到一半的標記」也先藏起來，免得閃一下；
  // 索引行寫在最後，串流中看到行首的標記就把它之後的都先藏起來（標記單獨一行時，下一行還沒打到「｜」前不會閃出來）
  function stripMark(text, live) {
    let s = String(text || '');
    if (live) for (const [k, at] of [[NOTE, NOTE_AT], [CHOICES, CHOICE_AT]]) if (s.includes(k)) { const i = s.search(at); if (i >= 0) s = s.slice(0, i); }
    if (s.includes(NOTE)) s = s.replace(NOTE_LINE, '').replace(/\s+$/, '');
    if (s.includes(CHOICES)) s = s.replace(CHOICE_LINE, '').replace(/\s+$/, '');
    // 標記單獨一行：整行拿掉；行首標記後面還有字：只拿掉標記
    if (hasMark(s)) return s.replace(/^[ \t>*_`-]*\[\[agentdesk:work\]\][ \t`*_]*(\r?\n|$)/gm, '').replace(MARK_AT, '$1').replace(/\s+$/, '');
    if (live) for (const k of [MARK, NOTE, CHOICES]) for (let n = k.length - 1; n >= 2; n--) if (s.endsWith(k.slice(0, n))) return s.slice(0, -n);
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

  const api = { applyEvent, MARK, NOTE, CHOICES, hasMark, stripMark, partsText };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Reduce = api;
})(this);
