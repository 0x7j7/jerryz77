// ==UserScript==
// @name         Tacit Finance Auto Mint FAIR
// @namespace    https://github.com/jerryz77
// @version      0.1.0
// @description  自动循环点击 Mint 按钮，确认后再点击 "Mint another?" 继续下一轮
// @match        https://tacit.finance/*
// @match        https://*.tacit.finance/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/*
 * 使用说明：
 * 1. 安装 Tampermonkey 扩展（Chrome / Edge / Firefox 都有）。
 * 2. 新建一个脚本，把本文件内容整个粘贴进去保存。
 * 3. 打开 https://tacit.finance/#tab=discover ，连接好钱包，进入 FAIR mint 页面。
 * 4. 页面右下角会出现一个悬浮控制面板：
 *      - Start：开始自动循环
 *      - Stop ：立即停止
 *      - 次数 ：你要 mint 的总次数 (0 = 无限)
 *      - 间隔 ：每次动作之间的等待毫秒数
 * 5. 每次 mint 钱包会弹窗，需要你自己点确认签名（安全起见不代签）。
 *    签名后脚本会等到出现 "Mint another?" 再点一次，继续下一轮。
 *
 * 注意：
 *  - 本脚本只做 UI 自动化，不接触你的私钥。
 *  - 如果 tacit 前端改了按钮文案/结构，需要调整下面的 SELECTORS / TEXTS 即可。
 */

(function () {
  'use strict';

  // ========== 可调参数 ==========
  const TEXTS = {
    mint: ['mint', '铸造'],                 // 主 mint 按钮里可能出现的文案（小写匹配）
    mintAnother: ['mint another', '再 mint', '再次', '继续'], // 完成后的“Mint another?”按钮
  };
  const DEFAULT_LOOP = 0;        // 默认无限循环
  const DEFAULT_INTERVAL = 1500; // 每步之间 1.5s 缓冲
  const CLICK_WAIT_TIMEOUT = 120_000; // 最多等 2 分钟一个按钮出现
  // ================================

  let running = false;
  let stopFlag = false;
  let doneCount = 0;

  const log = (...a) => console.log('%c[AutoMint]', 'color:#f90;font-weight:bold', ...a);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * 在整个 DOM（含 shadowRoot）里查找第一个文案匹配的可点击元素
   */
  function findClickable(textList) {
    const lowered = textList.map((t) => t.toLowerCase());
    const roots = [document];

    // 收集 shadowRoots
    const all = document.querySelectorAll('*');
    all.forEach((el) => {
      if (el.shadowRoot) roots.push(el.shadowRoot);
    });

    for (const root of roots) {
      const candidates = root.querySelectorAll(
        'button, a, [role="button"], input[type="button"], input[type="submit"], div, span'
      );
      for (const el of candidates) {
        if (!(el instanceof HTMLElement)) continue;
        // 必须可见、可点
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.pointerEvents === 'none') continue;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') continue;

        const text = (el.innerText || el.textContent || el.value || '').trim().toLowerCase();
        if (!text) continue;

        if (lowered.some((t) => text === t || text.startsWith(t) || text.includes(t))) {
          // 过滤明显过长的段落（避免把一段描述当按钮）
          if (text.length > 60) continue;
          return el;
        }
      }
    }
    return null;
  }

  async function waitForClickable(textList, timeout = CLICK_WAIT_TIMEOUT) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (stopFlag) throw new Error('stopped');
      const el = findClickable(textList);
      if (el) return el;
      await sleep(400);
    }
    throw new Error(`超时未找到按钮: ${textList.join(' / ')}`);
  }

  function clickIt(el) {
    el.scrollIntoView({ block: 'center' });
    // 用原生事件序列，尽量模拟真实点击
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach((type) => {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    });
  }

  async function oneRound(interval) {
    log(`第 ${doneCount + 1} 轮：等待 Mint 按钮...`);
    const mintBtn = await waitForClickable(TEXTS.mint);
    log('点击 Mint');
    clickIt(mintBtn);

    // 钱包弹窗需要用户自己签名，这里轮询等 "Mint another?" 出现
    log('等待用户在钱包中确认交易，并等待 "Mint another?" 出现...');
    const again = await waitForClickable(TEXTS.mintAnother);
    await sleep(interval);
    if (stopFlag) throw new Error('stopped');

    log('点击 Mint another?');
    clickIt(again);
    doneCount += 1;
    updatePanel();
    await sleep(interval);
  }

  async function mainLoop(total, interval) {
    running = true;
    stopFlag = false;
    doneCount = 0;
    updatePanel();
    try {
      while (!stopFlag && (total === 0 || doneCount < total)) {
        await oneRound(interval);
      }
      log(`完成，共成功 ${doneCount} 次`);
    } catch (e) {
      log('已停止：', e.message);
    } finally {
      running = false;
      updatePanel();
    }
  }

  // ============ 悬浮控制面板 ============
  let panel, countInput, intervalInput, statusEl, startBtn, stopBtn;
  function buildPanel() {
    panel = document.createElement('div');
    panel.style.cssText = `
      position:fixed; right:16px; bottom:16px; z-index:2147483647;
      background:#111; color:#eee; font:13px/1.4 system-ui,Segoe UI,Arial;
      padding:10px 12px; border:1px solid #444; border-radius:8px;
      box-shadow:0 4px 18px rgba(0,0,0,.4); min-width:210px;`;
    panel.innerHTML = `
      <div style="font-weight:600;color:#f90;margin-bottom:6px">Tacit Auto Mint</div>
      <label style="display:block;margin:4px 0">次数(0=∞)
        <input id="am-count" type="number" min="0" value="${DEFAULT_LOOP}"
          style="width:70px;margin-left:4px;background:#222;color:#eee;border:1px solid #555;border-radius:4px;padding:2px 4px"/>
      </label>
      <label style="display:block;margin:4px 0">间隔(ms)
        <input id="am-interval" type="number" min="200" step="100" value="${DEFAULT_INTERVAL}"
          style="width:70px;margin-left:4px;background:#222;color:#eee;border:1px solid #555;border-radius:4px;padding:2px 4px"/>
      </label>
      <div style="display:flex;gap:6px;margin-top:6px">
        <button id="am-start" style="flex:1;background:#2a7;color:#fff;border:0;padding:6px 0;border-radius:4px;cursor:pointer">Start</button>
        <button id="am-stop"  style="flex:1;background:#a33;color:#fff;border:0;padding:6px 0;border-radius:4px;cursor:pointer">Stop</button>
      </div>
      <div id="am-status" style="margin-top:6px;color:#9cf">idle</div>
    `;
    document.body.appendChild(panel);

    countInput = panel.querySelector('#am-count');
    intervalInput = panel.querySelector('#am-interval');
    statusEl = panel.querySelector('#am-status');
    startBtn = panel.querySelector('#am-start');
    stopBtn = panel.querySelector('#am-stop');

    startBtn.onclick = () => {
      if (running) return;
      const total = Math.max(0, parseInt(countInput.value || '0', 10));
      const interval = Math.max(200, parseInt(intervalInput.value || '1500', 10));
      mainLoop(total, interval);
    };
    stopBtn.onclick = () => {
      stopFlag = true;
      statusEl.textContent = '正在停止...';
    };
  }

  function updatePanel() {
    if (!statusEl) return;
    statusEl.textContent = running
      ? `运行中... 已完成 ${doneCount}`
      : `idle (已完成 ${doneCount})`;
  }

  // 页面有时是 SPA，等 body 准备好再挂面板
  const ready = setInterval(() => {
    if (document.body) {
      clearInterval(ready);
      buildPanel();
      log('已注入，右下角面板可操作');
    }
  }, 200);
})();
