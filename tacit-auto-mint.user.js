// ==UserScript==
// @name         Tacit Finance Auto Mint FAIR
// @namespace    https://github.com/jerryz77
// @version      0.5.0
// @description  全自动循环 mint FAIR（直接触发框架内部事件）
// @match        https://tacit.finance/*
// @match        https://*.tacit.finance/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
 * v0.5.0 - 核心改动：
 * 1. @run-at document-start：在页面代码加载前注入，确保 confirm 劫持生效
 * 2. 劫持 window.confirm：自动返回 true
 * 3. 使用 React 内部属性触发事件（绕过 isTrusted 检查）
 *
 * 流程: 点 [MINT 100] → confirm 自动通过 → 等 [Mint another?] → 点它 → 循环
 */

(function () {
  'use strict';

  // ========== 在页面最早期劫持 confirm ==========
  let autoConfirm = false;
  const _origConfirm = window.confirm;
  Object.defineProperty(window, 'confirm', {
    value: function (msg) {
      if (autoConfirm) {
        console.log('%c[AutoMint] ✓ 自动确认:', 'color:#0f0', msg);
        return true;
      }
      return _origConfirm.call(window, msg);
    },
    writable: true,
    configurable: true,
  });

  // 等 DOM 加载完再执行主逻辑
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  function init() {
    // 再等一会让 SPA 渲染完
    setTimeout(main, 1500);
  }

  function main() {
    const DEFAULT_LOOP = 0;
    const DEFAULT_INTERVAL = 1000;
    const POLL_INTERVAL = 300;
    const TX_TIMEOUT = 60_000;

    let running = false;
    let stopFlag = false;
    let doneCount = 0;

    const log = (...a) => console.log('%c[AutoMint]', 'color:#f90;font-weight:bold', ...a);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // ========== 查找 FAIR 项目的 Mint 按钮 ==========
    function findMintButton() {
      // 策略: 先找包含 "FAIR" 文字的卡片/容器，再在其中找 mint 按钮
      const allElements = document.querySelectorAll('*');
      let fairContainer = null;

      // 方法1: 找包含 "FAIR" 文字（且不是整个页面）的最小容器
      for (const el of allElements) {
        if (el.closest('#am-panel')) continue;
        const text = (el.innerText || el.textContent || '').trim();
        // 找到直接包含 "FAIR" 且文字不太长的元素（卡片标题）
        if (text === 'FAIR' || text === 'fair') {
          // 往上找父容器（卡片级别）
          fairContainer = el.closest('[class*="card"], [class*="item"], [class*="token"], [class*="row"], section, article') || el.parentElement?.parentElement?.parentElement;
          if (fairContainer) break;
        }
      }

      // 如果找到 FAIR 容器，在其中找 mint 按钮
      if (fairContainer) {
        const btns = fairContainer.querySelectorAll('button');
        for (const btn of btns) {
          if (btn.closest('#am-panel')) continue;
          const rect = btn.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          if (btn.disabled) continue;
          const text = (btn.innerText || btn.textContent || '').trim().toLowerCase();
          if (text.match(/^mint(\s+\d+)?$/) || (text.includes('mint') && !text.includes('another') && text.length < 20)) {
            return btn;
          }
        }
      }

      // 方法2: 如果页面已经进入了 FAIR 详情页（只有一个 mint 按钮）
      // 检查页面上是否有 "FAIR" 文字且只有一个 mint 按钮
      const pageText = document.body?.innerText || '';
      if (pageText.includes('FAIR') && pageText.includes('c4a678d6d674')) {
        // 确认我们在 FAIR 页面内
        const allBtns = document.querySelectorAll('button');
        for (const btn of allBtns) {
          if (btn.closest('#am-panel')) continue;
          const rect = btn.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          if (btn.disabled) continue;
          const text = (btn.innerText || btn.textContent || '').trim().toLowerCase();
          if (text.match(/^mint(\s+\d+)?$/) || (text.includes('mint') && !text.includes('another') && text.length < 20)) {
            return btn;
          }
        }
      }

      return null;
    }

    // ========== 查找 "Mint another?" ==========
    function findMintAnother() {
      const links = document.querySelectorAll('a');
      for (const link of links) {
        const text = (link.innerText || link.textContent || '').trim().toLowerCase();
        if (text.includes('mint another')) {
          const rect = link.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) return link;
        }
      }
      // 备选
      const els = document.querySelectorAll('button, span, div, p');
      for (const el of els) {
        const text = (el.innerText || el.textContent || '').trim().toLowerCase();
        if (text.includes('mint another') && text.length < 30) {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) return el;
        }
      }
      return null;
    }

    // ========== 触发 React/框架 内部事件 ==========
    function getReactProps(el) {
      // React 16+ 存储在 __reactProps$ 或 __reactFiber$ 开头的 key 上
      for (const key of Object.keys(el)) {
        if (key.startsWith('__reactProps$') || key.startsWith('__reactEvents$')) {
          return el[key];
        }
      }
      return null;
    }

    function triggerReactClick(el) {
      const props = getReactProps(el);
      if (props && props.onClick) {
        log('  → 触发 React onClick');
        props.onClick(new MouseEvent('click', { bubbles: true }));
        return true;
      }
      // 往上找父元素的 React props
      let parent = el.parentElement;
      let depth = 0;
      while (parent && depth < 5) {
        const parentProps = getReactProps(parent);
        if (parentProps && parentProps.onClick) {
          log('  → 触发父元素 React onClick (depth:', depth + 1, ')');
          parentProps.onClick(new MouseEvent('click', { bubbles: true }));
          return true;
        }
        parent = parent.parentElement;
        depth++;
      }
      return false;
    }

    // ========== 通用点击 ==========
    function simulateClick(el) {
      log('  → 点击:', el.tagName, `"${(el.innerText || '').trim().substring(0, 30)}"`);
      el.scrollIntoView({ block: 'center' });

      // 方法1: 尝试 React 内部 onClick
      if (triggerReactClick(el)) return;

      // 方法2: Svelte/Vue 等 - 检查 __svelte 或 __vue
      // 这些框架通常响应原生 click 事件

      // 方法3: 派发完整事件序列
      const rect = el.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 };

      el.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerId: 1, pointerType: 'mouse' }));
      el.dispatchEvent(new MouseEvent('mousedown', opts));
      el.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerId: 1, pointerType: 'mouse' }));
      el.dispatchEvent(new MouseEvent('mouseup', opts));
      el.dispatchEvent(new MouseEvent('click', opts));

      // 方法4: 原生 click
      el.click();
    }

    // ========== 等待 ==========
    async function waitFor(findFn, label, timeout = TX_TIMEOUT) {
      const start = Date.now();
      while (Date.now() - start < timeout) {
        if (stopFlag) throw new Error('用户停止');
        const el = findFn();
        if (el) return el;
        await sleep(POLL_INTERVAL);
      }
      throw new Error(`超时: ${label}`);
    }

    // ========== 核心循环 ==========
    async function oneRound(interval) {
      log(`--- 第 ${doneCount + 1} 轮 ---`);

      // 步骤1: 找到 Mint 按钮
      updateStatus(`第 ${doneCount + 1} 轮: 找 Mint 按钮...`);
      const mintBtn = await waitFor(findMintButton, 'Mint 按钮');
      await sleep(300);
      if (stopFlag) throw new Error('用户停止');

      // 开启 confirm 自动确认
      autoConfirm = true;
      log('步骤1: 点击 Mint');
      simulateClick(mintBtn);

      // 给一点时间让 confirm 触发
      await sleep(500);

      // 步骤2: 等 "Mint another?" 出现
      updateStatus(`第 ${doneCount + 1} 轮: 等待交易完成...`);
      log('步骤2: 等 Mint another?...');
      const again = await waitFor(findMintAnother, 'Mint another?');
      autoConfirm = false;

      // 步骤3: 点 "Mint another?"
      await sleep(interval);
      if (stopFlag) throw new Error('用户停止');
      log('步骤3: 点 Mint another?');
      simulateClick(again);

      doneCount += 1;
      log(`✓ 第 ${doneCount} 轮完成`);
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
        log(`=== 完成 ${doneCount} 次 ===`);
        updateStatus(`✓ 完成! ${doneCount} 次`);
      } catch (e) {
        log('停止:', e.message);
        updateStatus(`停止: ${e.message}`);
      } finally {
        running = false;
        autoConfirm = false;
        updatePanel();
      }
    }

    // ========== 控制面板 ==========
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
        <div style="font-weight:700;color:#f90;margin-bottom:8px;font-size:14px">⚡ Auto Mint FAIR</div>
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
          <button id="am-stop" style="flex:1;background:#dc3545;color:#fff;border:0;padding:7px 0;border-radius:5px;cursor:pointer;font-weight:600">■ Stop</button>
        </div>
        <div id="am-status" style="margin-top:8px;padding:4px 6px;background:#0d0d1a;border-radius:4px;color:#9cf;font-size:12px">idle</div>
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
      stopBtn.onclick = () => { stopFlag = true; updateStatus('停止中...'); };
    }

    function updateStatus(msg) { if (statusEl) statusEl.textContent = msg; }
    function updatePanel() {
      if (!statusEl) return;
      if (running) {
        updateStatus(`运行中... 已完成 ${doneCount}`);
        startBtn.style.opacity = '0.5';
      } else {
        startBtn.style.opacity = '1';
      }
    }

    buildPanel();
    log('脚本就绪 v0.5.0 (confirm劫持 + React内部触发)');
  }
})();
