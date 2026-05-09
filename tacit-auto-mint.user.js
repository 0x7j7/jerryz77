// ==UserScript==
// @name         Tacit Finance Auto Mint FAIR
// @namespace    https://github.com/jerryz77
// @version      0.4.0
// @description  全自动循环 mint FAIR（含自动点确认弹窗）
// @match        https://tacit.finance/*
// @match        https://*.tacit.finance/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/*
 * 使用说明：
 * 1. 安装 Tampermonkey 扩展
 * 2. 新建脚本，粘贴保存
 * 3. 打开 https://tacit.finance/#tab=discover ，登录网站钱包，进入 FAIR mint 页面
 * 4. 右下角面板点 Start，全自动循环：
 *      点 Mint → 自动点确认弹窗 → 等交易完成 → 点 "Mint another?" → 重复
 *
 * 流程: Mint按钮 → 确认弹窗("确定") → 交易完成 → "Mint another?" → 循环
 */

(function () {
  'use strict';

  const DEFAULT_LOOP = 0;         // 0 = 无限循环
  const DEFAULT_INTERVAL = 1000;  // 每步间隔 ms（可在面板调）
  const POLL_INTERVAL = 300;      // 轮询检测间隔 ms
  const TX_TIMEOUT = 60_000;      // 交易最多等 60 秒

  let running = false;
  let stopFlag = false;
  let doneCount = 0;

  const log = (...a) => console.log('%c[AutoMint]', 'color:#f90;font-weight:bold', ...a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ========== 劫持 window.confirm 自动返回 true ==========
  // 弹窗 "Mint 100 FAIR?" 是浏览器原生 confirm()，劫持后自动确认
  let autoConfirm = false;
  const originalConfirm = window.confirm.bind(window);
  window.confirm = function (msg) {
    if (autoConfirm) {
      log('  ✓ 自动确认弹窗:', msg);
      return true;
    }
    return originalConfirm(msg);
  };

  // ========== 元素查找 ==========

  /**
   * 查找 "Mint another?" 链接
   */
  function findMintAnotherLink() {
    // 查所有 <a> 标签
    const links = document.querySelectorAll('a');
    for (const link of links) {
      const text = (link.innerText || link.textContent || '').trim().toLowerCase();
      if (text.includes('mint another')) {
        const rect = link.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) return link;
      }
    }

    // 备选: 查所有可点击元素
    const all = document.querySelectorAll('button, span, div, p, [role="button"]');
    for (const el of all) {
      if (!(el instanceof HTMLElement)) continue;
      const text = (el.innerText || el.textContent || '').trim().toLowerCase();
      if (text.includes('mint another') && text.length < 30) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) return el;
      }
    }
    return null;
  }

  /**
   * 查找 Mint 按钮（排除 "Mint another" 和我们面板）
   */
  function findMintButton() {
    const candidates = document.querySelectorAll('button, [role="button"], input[type="submit"]');
    for (const el of candidates) {
      if (!(el instanceof HTMLElement)) continue;
      if (el.closest('#am-panel')) continue;

      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') continue;
      if (el.offsetParent === null && el.style.position !== 'fixed') continue;

      const text = (el.innerText || el.textContent || el.value || '').trim().toLowerCase();
      // 匹配 "mint", "mint 100", "mint 50" 等，但排除 "mint another"
      if (text === 'mint' || (text.match(/^mint\s*\d*$/) && text.length < 20) ||
          (text.includes('mint') && !text.includes('another') && text.length < 20)) {
        return el;
      }
    }
    return null;
  }

  // ========== 点击逻辑 ==========

  /**
   * 使用多种方式模拟真实用户点击
   * 关键: 框架(React/Svelte等)通常监听 mousedown→mouseup→click 完整序列
   */
  function realClick(el) {
    log('  → 点击:', el.tagName, `"${(el.innerText || '').trim().substring(0, 30)}"`);
    el.scrollIntoView({ block: 'center' });

    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;

    // 先聚焦元素
    el.focus();

    // 派发完整的指针和鼠标事件序列（模拟真实用户交互）
    const eventInit = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: x,
      clientY: y,
      screenX: x,
      screenY: y,
      button: 0,
      buttons: 1,
    };

    el.dispatchEvent(new PointerEvent('pointerdown', { ...eventInit, pointerId: 1, pointerType: 'mouse' }));
    el.dispatchEvent(new MouseEvent('mousedown', eventInit));
    el.dispatchEvent(new PointerEvent('pointerup', { ...eventInit, pointerId: 1, pointerType: 'mouse', buttons: 0 }));
    el.dispatchEvent(new MouseEvent('mouseup', { ...eventInit, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('click', { ...eventInit, buttons: 0 }));

    // 兜底: 原生 .click()
    setTimeout(() => { el.click(); }, 30);
  }

  // ========== 等待逻辑 ==========

  async function waitFor(findFn, label, timeout = TX_TIMEOUT) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (stopFlag) throw new Error('用户停止');
      const el = findFn();
      if (el) return el;
      await sleep(POLL_INTERVAL);
    }
    throw new Error(`超时(${timeout / 1000}s)未找到: ${label}`);
  }

  // ========== 核心循环 ==========

  async function oneRound(interval) {
    log(`--- 第 ${doneCount + 1} 轮 ---`);

    // 步骤1: 点击 Mint（开启自动确认，因为 confirm() 是同步的会在 click 里触发）
    updateStatus(`第 ${doneCount + 1} 轮: 寻找 Mint 按钮...`);
    const mintBtn = await waitFor(findMintButton, 'Mint 按钮');
    await sleep(300);
    if (stopFlag) throw new Error('用户停止');

    // 开启自动确认 - confirm() 弹窗会自动返回 true
    autoConfirm = true;
    log('步骤1: 点击 Mint（自动确认已开启）');
    realClick(mintBtn);

    // 步骤2: 等 "Mint another?" 出现（交易自动完成）
    updateStatus(`第 ${doneCount + 1} 轮: 等待交易完成...`);
    log('步骤2: 等待交易完成...');
    const mintAnotherEl = await waitFor(findMintAnotherLink, 'Mint another?');

    // 关闭自动确认
    autoConfirm = false;

    // 步骤3: 点 "Mint another?"
    await sleep(interval);
    if (stopFlag) throw new Error('用户停止');
    log('步骤3: 点击 Mint another?');
    realClick(mintAnotherEl);

    doneCount += 1;
    log(`✓ 第 ${doneCount} 轮完成`);
    updatePanel();

    // 短暂等待页面恢复
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
      log(`=== 完成，共 ${doneCount} 次 ===`);
      updateStatus(`✓ 完成! 共 ${doneCount} 次`);
    } catch (e) {
      log('停止:', e.message);
      updateStatus(`停止: ${e.message}`);
    } finally {
      running = false;
      updatePanel();
    }
  }

  // ============ 控制面板 ============
  let panel, countInput, intervalInput, statusEl, startBtn, stopBtn;

  function buildPanel() {
    panel = document.createElement('div');
    panel.id = 'am-panel';
    panel.style.cssText = `
      position:fixed; right:16px; bottom:16px; z-index:2147483647;
      background:#1a1a2e; color:#eee; font:13px/1.5 system-ui,sans-serif;
      padding:12px 14px; border:1px solid #555; border-radius:10px;
      box-shadow:0 4px 20px rgba(0,0,0,.5); min-width:220px;
      user-select:none;`;
    panel.innerHTML = `
      <div style="font-weight:700;color:#f90;margin-bottom:8px;font-size:14px">
        ⚡ Auto Mint FAIR
      </div>
      <label style="display:flex;align-items:center;margin:5px 0;gap:8px">
        <span style="min-width:70px">次数(0=∞)</span>
        <input id="am-count" type="number" min="0" value="${DEFAULT_LOOP}"
          style="width:70px;background:#222;color:#eee;border:1px solid #555;border-radius:4px;padding:3px 6px"/>
      </label>
      <label style="display:flex;align-items:center;margin:5px 0;gap:8px">
        <span style="min-width:70px">间隔(ms)</span>
        <input id="am-interval" type="number" min="200" step="200" value="${DEFAULT_INTERVAL}"
          style="width:70px;background:#222;color:#eee;border:1px solid #555;border-radius:4px;padding:3px 6px"/>
      </label>
      <div style="display:flex;gap:8px;margin-top:8px">
        <button id="am-start" style="flex:1;background:#28a745;color:#fff;border:0;padding:7px 0;border-radius:5px;cursor:pointer;font-weight:600">▶ Start</button>
        <button id="am-stop"  style="flex:1;background:#dc3545;color:#fff;border:0;padding:7px 0;border-radius:5px;cursor:pointer;font-weight:600">■ Stop</button>
      </div>
      <div id="am-status" style="margin-top:8px;padding:4px 6px;background:#0d0d1a;border-radius:4px;color:#9cf;font-size:12px">
        idle - 点 Start 全自动开跑
      </div>
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
      const interval = Math.max(200, parseInt(intervalInput.value || '1000', 10));
      mainLoop(total, interval);
    };
    stopBtn.onclick = () => {
      stopFlag = true;
      updateStatus('正在停止...');
    };

    // 可拖动
    let dragging = false, dx = 0, dy = 0;
    panel.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') return;
      dragging = true;
      dx = e.clientX - panel.offsetLeft;
      dy = e.clientY - panel.offsetTop;
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      panel.style.left = (e.clientX - dx) + 'px';
      panel.style.top = (e.clientY - dy) + 'px';
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    });
    document.addEventListener('mouseup', () => { dragging = false; });
  }

  function updateStatus(msg) {
    if (statusEl) statusEl.textContent = msg;
  }

  function updatePanel() {
    if (!statusEl) return;
    if (running) {
      updateStatus(`运行中... 已完成 ${doneCount} 次`);
      startBtn.style.opacity = '0.5';
    } else {
      startBtn.style.opacity = '1';
    }
  }

  // 初始化
  const ready = setInterval(() => {
    if (document.body) {
      clearInterval(ready);
      buildPanel();
      log('脚本就绪，全自动模式（网站钱包，无需手动确认）');
    }
  }, 300);
})();
