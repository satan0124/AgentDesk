// 主程序與畫面共用：自訂 Agent 範本的預設值與舊設定升級。
(function (root) {
  // Antigravity CLI（agy）：模型預設由 CLI 自己決定，可選的模型由 `agy models` 動態取得；推理強度預設 high
  const ANTIGRAVITY = {
    modelsArgs: 'models', model: '',
    effortFlag: '--effort', efforts: 'low medium high xhigh max', effort: 'high',
  };
  // 舊的 Antigravity 設定（還沒有 effortFlag 欄位的）：缺的或空的欄位照範本補；升級過的設定使用者改什麼都照原樣
  function upgradeCustom(cfg) {
    if (!cfg?.custom || cfg.format !== 'antigravity' || cfg.effortFlag !== undefined) return cfg;
    const out = { ...cfg };
    for (const [k, v] of Object.entries(ANTIGRAVITY)) if (out[k] === undefined || out[k] === '') out[k] = v;
    return out;
  }
  // 自訂 Agent 的強度選項（空白或逗號分隔）；沒有強度旗標就不給選
  const effortList = cfg => (cfg?.effortFlag ? String(cfg.efforts || '').split(/[\s,]+/).filter(Boolean) : []);

  const api = { ANTIGRAVITY, upgradeCustom, effortList };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Presets = api;
})(this);
