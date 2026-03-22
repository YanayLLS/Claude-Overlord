// Overlord — Renderer script
// Manages terminal panel, agent context, and IPC message forwarding

(function () {
  'use strict';

  // ── Message Forwarding ─────────────────────────────────
  // Forward main process messages as window MessageEvents
  // so the webview-ui React app receives them via its useExtensionMessages hook
  window.overlordAPI.onExtensionMessage((data) => {
    window.dispatchEvent(new MessageEvent('message', { data }));
  });

  // ── Terminal Management ────────────────────────────────
  const { Terminal } = window.xtermBundle;
  const { FitAddon } = window.xtermFitBundle;

  const terminalInstances = new Map(); // agentId -> { terminal, fitAddon, element }
  let activeTerminalId = null;
  let agentInfoMap = new Map(); // agentId -> { name, cwd, status, preview, prompt }

  const tabsContainer = document.getElementById('terminal-tabs');
  const termContainer = document.getElementById('terminal-container');
  const contextPanel = document.getElementById('context-panel');
  const emptyState = document.getElementById('terminal-empty');
  const terminalArea = document.getElementById('terminal-area');

  // Resizable terminal panel
  const resizeHandle = document.getElementById('resize-handle');
  let isResizing = false;
  let startY = 0;
  let startHeight = 0;

  if (resizeHandle && terminalArea) {
    resizeHandle.addEventListener('mousedown', (e) => {
      isResizing = true;
      startY = e.clientY;
      startHeight = terminalArea.offsetHeight;
      document.body.style.cursor = 'ns-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!isResizing) return;
      const delta = startY - e.clientY;
      const newHeight = Math.max(120, Math.min(window.innerHeight - 200, startHeight + delta));
      terminalArea.style.height = newHeight + 'px';
      fitAllTerminals();
    });
    document.addEventListener('mouseup', () => {
      if (isResizing) {
        isResizing = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    });
  }

  function createTerminal(agentId) {
    const el = document.createElement('div');
    el.className = 'terminal-instance';
    el.style.display = 'none';
    termContainer.appendChild(el);

    const fitAddon = new FitAddon();
    const terminal = new Terminal({
      theme: {
        background: '#000000',
        foreground: '#cdd6f4',
        cursor: '#f5e0dc',
        cursorAccent: '#000000',
        selectionBackground: '#585b7066',
        black: '#45475a',
        red: '#f38ba8',
        green: '#a6e3a1',
        yellow: '#f9e2af',
        blue: '#89b4fa',
        magenta: '#cba6f7',
        cyan: '#94e2d5',
        white: '#bac2de',
        brightBlack: '#585b70',
        brightRed: '#f38ba8',
        brightGreen: '#a6e3a1',
        brightYellow: '#f9e2af',
        brightBlue: '#89b4fa',
        brightMagenta: '#cba6f7',
        brightCyan: '#94e2d5',
        brightWhite: '#a6adc8',
      },
      fontFamily: '"Cascadia Mono", "Cascadia Code", "JetBrains Mono", Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: 'bar',
      cursorWidth: 2,
      scrollback: 5000,
    });

    terminal.loadAddon(fitAddon);
    terminal.open(el);
    fitAddon.fit();

    // Send user keystrokes to the process
    terminal.onData((data) => {
      window.overlordAPI.sendTerminalInput(agentId, data);
    });

    terminalInstances.set(agentId, { terminal, fitAddon, element: el });

    // Create tab
    const tab = document.createElement('button');
    tab.className = 'terminal-tab';
    tab.dataset.agentId = agentId;
    const info = agentInfoMap.get(agentId);
    tab.textContent = info?.name || `Agent ${agentId}`;
    tab.addEventListener('click', () => switchTerminal(agentId));
    tabsContainer.appendChild(tab);

    if (emptyState) emptyState.style.display = 'none';
    switchTerminal(agentId);
  }

  function removeTerminal(agentId) {
    const inst = terminalInstances.get(agentId);
    if (inst) {
      inst.terminal.dispose();
      inst.element.remove();
      terminalInstances.delete(agentId);
    }
    // Remove tab
    const tab = tabsContainer.querySelector(`[data-agent-id="${agentId}"]`);
    if (tab) tab.remove();

    agentInfoMap.delete(agentId);

    if (activeTerminalId === agentId) {
      activeTerminalId = null;
      // Switch to another terminal if available
      const remaining = [...terminalInstances.keys()];
      if (remaining.length > 0) {
        switchTerminal(remaining[remaining.length - 1]);
      } else {
        updateContextPanel();
        if (emptyState) emptyState.style.display = '';
      }
    }
  }

  function switchTerminal(agentId) {
    activeTerminalId = agentId;

    // Hide all, show selected
    for (const [id, inst] of terminalInstances) {
      inst.element.style.display = id === agentId ? '' : 'none';
    }

    // Update tab active state
    for (const tab of tabsContainer.querySelectorAll('.terminal-tab')) {
      tab.classList.toggle('active', parseInt(tab.dataset.agentId, 10) === agentId);
    }

    // Fit the active terminal
    const inst = terminalInstances.get(agentId);
    if (inst) {
      setTimeout(() => inst.fitAddon.fit(), 50);
      inst.terminal.focus();
    }

    // Notify the webview to select this agent (updates pixel office)
    window.acquireVsCodeApi().postMessage({ type: 'focusAgent', id: agentId });

    updateContextPanel();
  }

  function fitAllTerminals() {
    for (const [, inst] of terminalInstances) {
      try { inst.fitAddon.fit(); } catch { /* ignore */ }
    }
  }

  // Resize observer for terminal container
  if (termContainer) {
    new ResizeObserver(() => fitAllTerminals()).observe(termContainer);
  }

  // ── Terminal Data ──────────────────────────────────────
  window.overlordAPI.onTerminalData((id, data) => {
    const inst = terminalInstances.get(id);
    if (inst) inst.terminal.write(data);
  });

  window.overlordAPI.onTerminalExit((id) => {
    const inst = terminalInstances.get(id);
    if (inst) {
      inst.terminal.write('\r\n\x1b[33m[Session ended. Press any key to close.]\x1b[0m\r\n');
    }
  });

  window.overlordAPI.onFocusTerminal((id) => {
    if (terminalInstances.has(id)) switchTerminal(id);
  });

  // ── Context Panel ──────────────────────────────────────
  function updateContextPanel() {
    if (!contextPanel) return;
    const id = activeTerminalId;
    if (!id) {
      contextPanel.innerHTML = '<div class="context-empty">No agent selected</div>';
      return;
    }
    const info = agentInfoMap.get(id) || {};
    const statusClass = info.status === 'waiting' ? 'status-waiting'
      : info.status === 'permission' ? 'status-permission'
      : 'status-active';

    contextPanel.innerHTML = `
      <div class="context-header">
        <span class="context-name">${info.name || 'Agent ' + id}</span>
        <span class="context-status ${statusClass}">${info.status || 'idle'}</span>
      </div>
      <div class="context-section">
        <div class="context-label">Project</div>
        <div class="context-value">${info.cwd || 'Not set'}</div>
      </div>
      ${info.prompt ? `
      <div class="context-section">
        <div class="context-label">Last Prompt</div>
        <div class="context-value context-preview">${escapeHtml(info.prompt)}</div>
      </div>` : ''}
      ${info.preview ? `
      <div class="context-section">
        <div class="context-label">Last Response</div>
        <div class="context-value context-preview">${escapeHtml(info.preview)}</div>
      </div>` : ''}
      ${info.tools ? `
      <div class="context-section">
        <div class="context-label">Current Activity</div>
        <div class="context-value">${info.tools.map(t => `<div class="context-tool">${escapeHtml(t)}</div>`).join('')}</div>
      </div>` : ''}
      <div class="context-section">
        <div class="context-label">Stats</div>
        <div class="context-stats">
          <span>Turns: ${info.stats?.turnCount || 0}</span>
          <span>Tokens: ${formatTokens(info.stats?.totalInputTokens || 0)}</span>
        </div>
      </div>
    `;
  }

  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function formatTokens(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return String(n);
  }

  // ── Listen for agent messages (from extension-message forwarding) ──
  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || !msg.type) return;

    switch (msg.type) {
      case 'agentCreated': {
        const id = msg.id;
        if (!agentInfoMap.has(id)) {
          agentInfoMap.set(id, { status: 'active', tools: [] });
        }
        createTerminal(id);
        break;
      }
      case 'agentClosed': {
        removeTerminal(msg.id);
        break;
      }
      case 'agentStatus': {
        const info = agentInfoMap.get(msg.id);
        if (info) {
          info.status = msg.status;
          if (msg.id === activeTerminalId) updateContextPanel();
        }
        // Update tab styling
        const tab = tabsContainer.querySelector(`[data-agent-id="${msg.id}"]`);
        if (tab) {
          tab.classList.remove('tab-active-agent', 'tab-waiting', 'tab-permission');
          if (msg.status === 'active') tab.classList.add('tab-active-agent');
          else if (msg.status === 'waiting') tab.classList.add('tab-waiting');
          else if (msg.status === 'permission') tab.classList.add('tab-permission');
        }
        break;
      }
      case 'agentToolStart': {
        const info = agentInfoMap.get(msg.id);
        if (info) {
          if (!info.tools) info.tools = [];
          info.tools.push(msg.status);
          if (msg.id === activeTerminalId) updateContextPanel();
        }
        break;
      }
      case 'agentToolDone': {
        const info = agentInfoMap.get(msg.id);
        if (info && info.tools) {
          info.tools.shift();
          if (msg.id === activeTerminalId) updateContextPanel();
        }
        break;
      }
      case 'agentToolsClear': {
        const info = agentInfoMap.get(msg.id);
        if (info) {
          info.tools = [];
          if (msg.id === activeTerminalId) updateContextPanel();
        }
        break;
      }
      case 'agentPreview': {
        const info = agentInfoMap.get(msg.id);
        if (info) {
          info.preview = msg.text;
          if (msg.id === activeTerminalId) updateContextPanel();
        }
        break;
      }
      case 'agentUserPrompt': {
        const info = agentInfoMap.get(msg.id);
        if (info) {
          info.prompt = msg.text;
          if (msg.id === activeTerminalId) updateContextPanel();
        }
        break;
      }
      case 'agentCwd': {
        const info = agentInfoMap.get(msg.id) || {};
        info.cwd = msg.cwd;
        agentInfoMap.set(msg.id, info);
        // Update tab title to show folder name
        const tab = tabsContainer.querySelector(`[data-agent-id="${msg.id}"]`);
        if (tab && msg.cwd) {
          const name = msg.cwd.split(/[\\/]/).pop();
          tab.textContent = name || tab.textContent;
          info.name = name;
        }
        if (msg.id === activeTerminalId) updateContextPanel();
        break;
      }
      case 'agentNamesLoaded': {
        if (msg.names) {
          for (const [id, name] of Object.entries(msg.names)) {
            const numId = parseInt(id, 10);
            const info = agentInfoMap.get(numId);
            if (info) info.name = name;
            const tab = tabsContainer.querySelector(`[data-agent-id="${numId}"]`);
            if (tab) tab.textContent = name;
          }
          if (activeTerminalId !== null) updateContextPanel();
        }
        break;
      }
      case 'agentTurnProgress': {
        // Update stats
        const info = agentInfoMap.get(msg.id);
        if (info) {
          if (!info.stats) info.stats = {};
          info.stats.turnToolCount = msg.toolCount;
        }
        break;
      }
    }
  });
})();
