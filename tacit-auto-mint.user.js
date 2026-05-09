// ==UserScript==
// @name         Tacit Finance Auto Mint FAIR
// @namespace    https://github.com/jerryz77
// @version      0.2.0
// @description  自动循环 mint FAIR：点 Mint → 等确认 → 点 "Mint another?" → 循环
// @match        https://tacit.finance/*
// @match        https://*.tacit.finance/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/*
 * 使用说明：
 * 1. 安装 Tampermonkey 扩展（Chrome / Edge / Firefox 都有）。
 * 2. 新建脚本，粘贴本文件全部内容，保存。
 * 3. 打开 https://tacit.finance/#tab=discover ，连接钱包，进入 FAIR mint 页面。
 * 4. 右下角出现悬浮面板，点 Start 开始。
 * 5. 钱包弹窗需手动确认签名，脚本会自动等待并点击 "Mint another?"。
 */

(function () {
  'use strict';

  const DEFAULT_LOOP = 0;         // 0 = 无限
  const DEFAULT_INTERVAL = 2000;  // ms
  const POLL_INTERVAL = 500;      // 轮询间隔 ms
  const CLICK_TIMEOUT = 180_000;  // 最多等 3 分钟

  let running = false;
  let stopFlag = false;
  let doneCount = 0;

  const log = (...a) => console.log('%c[AutoMint]', 'color:#f90;font-weight:bold', ...a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * 查找包含指定文本的可见元素（专门查 <a> 和 <button>）
   * 对 "Mint another?" 这种链接，优先匹配 <a> 标签
   */
  function findElementByText(searchTexts, tagFilter) {
    const tags = tagFilter || 'a, button, [role="button"], input[type="submit"], input[type="button"]';
    const candidates = document.querySelectorAll(tags);

    for (const el of candidates) {
      if (!(el instanceof HTMLElement)) continue;

      // 跳过不可见元素
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (el.offsetParent === null && el.style.position !== 'fixed') continue;

      // 跳过 disabled
      if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') continue;

      const text = (el.innerText || el.textContent || el.value || '').trim().toLowerCase();
      if (!text) continue;

      for (const search of searchTexts) {
        const s = search.toLowerCase();
        // 精确匹配或包含匹配
        if (text === s || text.includes(s)) {
          // 排除太长的（避免匹配到整个容器）
          if (text.length > 40) continue;
          return el;
        }
      }
    }
    return null;
  }

  /**
   * 查找 "Mint another?" 链接 - 专门针对 <a> 标签
   */
  function findMintAnotherLink() {
    // 方法1: 直接查找所有 <a> 标签中包含 "mint another" 的
    const links = document.querySelectorAll('a');
    for (const link of links) {
      const text = (link.innerText || link.textContent || '').trim().toLowerCase();
      if (text.includes('mint another')) {
        const rect = link.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          return link;
        }
      }
    }

    // 方法2: 用 XPath 查找
    try {
      const xpath = "//a[contains(translate(text(), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'mint another')]";
      const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      if (result.singleNodeValue) return result.singleNodeValue;
    } catch (e) { /* ignore */ }

    // 方法3: 查所有可点击元素
    return findElementByText(['mint another?', 'mint another']);
  }

  /**
   * 查找 Mint 按钮（不是 "Mint another"）
   */
  function findMintButton() {
    const candidates = document.querySelectorAll('button, [role="button"], input[type="submit"]');
    for (const el of candidates) {
      if (!(el instanceof HTMLElement)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') continue;
      if (el.offsetParent === null && el.style.position !== 'fixed') continue;

      const text = (el.innerText || el.textContent || el.value || '').trim().toLowerCase();
      // 必须是 "mint" 但不能是 "mint another"
      if (text === 'mint' || (text.includes('mint') && !text.includes('another') && text.length < 20)) {
        // 排除我们自己面板里的按钮
        if (el.closest('#am-panel')) continue;
        return el;
      }
    }
    return null;
  }

  /**
   * 真实点击 - 多种方式确保触发
   */
  function realClick(el) {
    log('  → 点击元素:', el.tagName, `"${(el.innerText || '').trim().substring(0, 30)}"`);

    el.scrollIntoView({ block: 'center', behavior: 'smooth' });

    // 方式1: 原生 .click() - 对 <a> 标签最有效
    el.click();

    // 方式2: 派发完整的鼠标事件序列
    setTimeout(() => {
      const events = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
      const rect = el.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;

      events.forEach((type) => {
        el.dispatchEvent(new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: x,
          clientY: y,
        }));
      });
    }, 100);

    // 方式3: 如果是 <a> 标签且有 href，尝试触发导航
    if (el.tagName === 'A' && el.href) {
      setTimeout(() => {
        // 检查是否有 onclick handler 或者 hash link
        if (el.href.includes('#') || el.href === window.location.href) {
          // 是个 hash 路由或当前页面链接，用 click 就行
        } else {
          // 可能需要 location 跳转
          // window.location.href = el.href; // 不敢随便跳，先靠 click
        }
      }, 200);
    }
  }

  /**
   * 等待元素出现并返回
   */
  async function waitFor(findFn, label, timeout = CLICK_TIMEOUT) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (stopFlag) throw new Error('用户停止');
      const el = findFn();
      if (el) return el;
      await sleep(POLL_INTERVAL);
    }
    throw new Error(`超时(${timeout / 1000}s)未找到: ${label}`);
  }

  /**
   * 等待 "Mint another?" 出现（说明上一笔交易已确认）
   */
  async function waitForMintAnother() {
    return waitFor(findMintAnotherLink, 'Mint another?');
  }

  /**
   * 等待 Mint 按钮出现
   */
  async function waitForMintButton() {
    return waitFor(findMintButton, 'Mint 按钮');
  }

  /**
   * 一轮完整的 mint 流程
   */
  async function oneRound(interval) {
    // 步骤1: 找到并点击 Mint 按钮
    log(`--- 第 ${doneCount + 1} 轮 ---`);
    log('步骤1: 寻找 Mint 按钮...');
    const mintBtn = await waitForMintButton();
    await sleep(300); // 短暂等待确保页面稳定
    log('步骤1: 点击 Mint');
    realClick(mintBtn);

    // 步骤2: 等待交易确认，"Mint another?" 出现
    log('步骤2: 等待交易确认（请在钱包中签名）...');
    updateStatus(`第 ${doneCount + 1} 轮: 等待钱包确认...`);
    const mintAnotherEl = await waitForMintAnother();

    // 步骤3: 点击 "Mint another?"
    await sleep(interval); // 等一下再点，避免太快
    if (stopFlag) throw new Error('用户停止');
    log('步骤3: 点击 Mint another?');
    realClick(mintAnotherEl);

    doneCount += 1;
    log(`✓ 第 ${doneCount} 轮完成`);
    updatePanel();

    // 等待页面恢复到可以再次 mint 的状态
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
      log(`=== 全部完成，共 ${doneCount} 次 ===`);
      updateStatus(`完成! 共 ${doneCount} 次`);
    } catch (e) {
      log('停止:', e.message);
      updateStatus(`已停止: ${e.message}`);
    } finally {
      running = false;
      updatePanel();
    }
  }

  // ============ 悬浮控制面板 ============
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
        ⚡ Tacit Auto Mint
      </div>
      <label style="display:flex;align-items:center;margin:5px 0;gap:8px">
        <span style="min-width:70px">次数(0=∞)</span>
        <input id="am-count" type="number" min="0" value="${DEFAULT_LOOP}"
          style="width:70px;background:#222;color:#eee;border:1px solid #555;border-radius:4px;padding:3px 6px"/>
      </label>
      <label style="display:flex;align-items:center;margin:5px 0;gap:8px">
        <span style="min-width:70px">间隔(ms)</span>
        <input id="am-interval" type="number" min="500" step="500" value="${DEFAULT_INTERVAL}"
          style="width:70px;background:#222;color:#eee;border:1px solid #555;border-radius:4px;padding:3px 6px"/>
      </label>
      <div style="display:flex;gap:8px;margin-top:8px">
        <button id="am-start" style="flex:1;background:#28a745;color:#fff;border:0;padding:7px 0;border-radius:5px;cursor:pointer;font-weight:600">▶ Start</button>
        <button id="am-stop"  style="flex:1;background:#dc3545;color:#fff;border:0;padding:7px 0;border-radius:5px;cursor:pointer;font-weight:600">■ Stop</button>
      </div>
      <div id="am-status" style="margin-top:8px;padding:4px 6px;background:#0d0d1a;border-radius:4px;color:#9cf;font-size:12px">
        idle - 点击 Start 开始
      </div>
      <div style="margin-top:6px;font-size:11px;color:#888">
        调试: 打开 F12 Console 查看 [AutoMint] 日志
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
      const interval = Math.max(500, parseInt(intervalInput.value || '2000', 10));
      mainLoop(total, interval);
    };
    stopBtn.onclick = () => {
      stopFlag = true;
      updateStatus('正在停止...');
    };

    // 面板可拖动
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
      startBtn.style.cursor = 'not-allowed';
    } else {
      if (!statusEl.textContent.startsWith('完成') && !statusEl.textContent.startsWith('已停止')) {
        updateStatus(`idle (已完成 ${doneCount} 次)`);
      }
      startBtn.style.opacity = '1';
      startBtn.style.cursor = 'pointer';
    }
  }

  // 等 body 准备好再挂面板
  const ready = setInterval(() => {
    if (document.body) {
      clearInterval(ready);
      buildPanel();
      log('脚本已注入，右下角面板可操作');
      log('提示: 如果 "Mint another?" 点击无效，请在 Console 输入:');
      log('  document.querySelectorAll("a")  查看所有链接');
    }
  }, 300);
})();
