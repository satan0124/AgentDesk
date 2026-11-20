const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  listConvs: () => ipcRenderer.invoke('conv:list'),
  getConv: id => ipcRenderer.invoke('conv:get', id),
  createConv: cwd => ipcRenderer.invoke('conv:create', cwd),
  deleteConv: id => ipcRenderer.invoke('conv:delete', id),
  updateConv: (id, patch) => ipcRenderer.invoke('conv:update', id, patch),
  forkConv: (id, msgId) => ipcRenderer.invoke('conv:fork', id, msgId),
  readWork: id => ipcRenderer.invoke('work:read', id),
  listWorks: id => ipcRenderer.invoke('work:list', id),
  compress: (id, agent) => ipcRenderer.invoke('conv:compress', id, agent),
  compressInfo: (id, agent) => ipcRenderer.invoke('compress:info', id, agent),
  send: (convId, agent, text, atts) => ipcRenderer.invoke('chat:send', convId, agent, text, atts),
  addAttachments: items => ipcRenderer.invoke('att:add', items),
  pathOf: file => { try { return webUtils.getPathForFile(file) || ''; } catch { return ''; } },
  pickFiles: () => ipcRenderer.invoke('dialog:files'),
  stop: convId => ipcRenderer.invoke('chat:stop', convId),
  retry: convId => ipcRenderer.invoke('chat:retry', convId),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: s => ipcRenderer.invoke('settings:set', s),
  setClaudeKey: key => ipcRenderer.invoke('claudeApi:key', key),
  setBilling: patch => ipcRenderer.invoke('billing:set', patch),
  listModels: (agent, cfg) => ipcRenderer.invoke('models:list', agent, cfg),
  pickFolder: current => ipcRenderer.invoke('dialog:folder', current),
  openPath: p => ipcRenderer.invoke('open:path', p),
  readFile: p => ipcRenderer.invoke('file:read', p),
  fileMtime: p => ipcRenderer.invoke('file:mtime', p),
  reveal: p => ipcRenderer.invoke('open:reveal', p),
  openUrl: u => ipcRenderer.invoke('open:url', u),
  cliCheck: (agent, cfg, force) => ipcRenderer.invoke('cli:check', agent, cfg, !!force),
  envCheck: (form, cwd) => ipcRenderer.invoke('env:check', form, cwd),
  answerApproval: (id, allow) => ipcRenderer.invoke('approval:answer', id, allow),
  cliInstall: (agent, cfg) => ipcRenderer.invoke('cli:install', agent, cfg),
  cliLogin: (agent, cfg) => ipcRenderer.invoke('cli:login', agent, cfg),
  cliBrowse: () => ipcRenderer.invoke('cli:browse'),
  agentStatus: () => ipcRenderer.invoke('agents:status'),
  on: (channel, fn) => {
    const h = (_, data) => fn(data);
    ipcRenderer.on(channel, h);
    return () => ipcRenderer.removeListener(channel, h);
  },
});
