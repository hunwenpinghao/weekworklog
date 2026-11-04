'use strict';

const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const WEEKDAY_CN = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

let mainWindow = null;

function userDataFile() {
  return path.join(app.getPath('userData'), 'entries.json');
}

function projectSeedFile() {
  // Dev: project data/; packaged: extraResources/seed-data/
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'seed-data', 'entries.json');
  }
  return path.join(__dirname, '..', 'data', 'entries.json');
}

function nowIso() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const oh = pad(Math.floor(Math.abs(off) / 60));
  const om = pad(Math.abs(off) % 60);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${oh}:${om}`
  );
}

function ensureStore() {
  const dest = userDataFile();
  const dir = path.dirname(dest);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(dest)) return;

  // Migrate from project data/entries.json if present
  const seed = projectSeedFile();
  if (fs.existsSync(seed)) {
    try {
      fs.copyFileSync(seed, dest);
      return;
    } catch (_) {
      /* fall through */
    }
  }
  // Also try absolute project path used during first install
  const legacy = '/Users/aibee/Projects/week-worklog/data/entries.json';
  if (fs.existsSync(legacy)) {
    try {
      fs.copyFileSync(legacy, dest);
      return;
    } catch (_) {
      /* fall through */
    }
  }
  fs.writeFileSync(dest, '[]\n', 'utf8');
}

function loadEntries() {
  ensureStore();
  try {
    const raw = fs.readFileSync(userDataFile(), 'utf8').trim() || '[]';
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch (_) {
    return [];
  }
}

function saveEntries(entries) {
  ensureStore();
  const dest = userDataFile();
  const tmp = dest + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, dest);
}

function parseYMD(s) {
  if (!s || typeof s !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function toYMD(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function mondayOf(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = (x.getDay() + 6) % 7; // Mon=0 … Sun=6
  x.setDate(x.getDate() - day);
  return x;
}

function addDays(d, n) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() + n);
  return x;
}

function entriesInWeek(entries, weekStart) {
  const end = addDays(weekStart, 6);
  const startKey = toYMD(weekStart);
  const endKey = toYMD(end);
  return entries
    .filter((e) => e.date && e.date >= startKey && e.date <= endKey)
    .sort((a, b) => {
      const ka = `${a.date}|${a.start_time || ''}|${a.period || ''}|${a.created_at || ''}`;
      const kb = `${b.date}|${b.start_time || ''}|${b.period || ''}|${b.created_at || ''}`;
      return ka.localeCompare(kb);
    });
}

function timeLabel(entry) {
  const st = entry.start_time;
  const et = entry.end_time;
  const period = entry.period;
  if (st && et) return `${st}–${et}`;
  if (st) return `${st} 起`;
  if (period) return String(period);
  return '全天';
}

function exportMarkdown(entries, weekStart) {
  const end = addDays(weekStart, 6);
  const lines = [
    `# 周工作日志 ${toYMD(weekStart)} ~ ${toYMD(end)}`,
    '',
    '> 可直接交给智能体据此撰写一周工作汇报。',
    '',
  ];
  const byDay = {};
  for (const e of entries) {
    (byDay[e.date] ||= []).push(e);
  }
  for (let i = 0; i < 7; i++) {
    const d = addDays(weekStart, i);
    const key = toYMD(d);
    const dayEntries = byDay[key] || [];
    lines.push(`## ${WEEKDAY_CN[i]} ${key}`, '');
    if (!dayEntries.length) {
      lines.push('- （无记录）', '');
      continue;
    }
    for (const e of dayEntries) {
      const content = String(e.content || '')
        .trim()
        .replace(/\n/g, '\n  ');
      lines.push(`- **${timeLabel(e)}**：${content}`);
    }
    lines.push('');
  }
  lines.push('---', '', '## 本周要点（可选填写）', '', '- ', '');
  return lines.join('\n');
}

function normTime(v) {
  if (v == null || v === '') return null;
  if (typeof v !== 'string') return false;
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (!m) return false;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return false;
  return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
}

function validatePayload(body) {
  if (!body || typeof body !== 'object') return { error: '无效请求' };
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  if (!content) return { error: '内容不能为空' };
  const d = parseYMD(body.date);
  if (!d) return { error: '日期格式应为 YYYY-MM-DD' };
  const st = normTime(body.start_time);
  if (st === false) return { error: '开始时间格式应为 HH:MM' };
  const et = normTime(body.end_time);
  if (et === false) return { error: '结束时间格式应为 HH:MM' };
  let period = body.period;
  if (period == null || period === '') period = null;
  else if (typeof period !== 'string') return { error: '时段标签须为文本' };
  else period = period.trim() || null;
  return {
    fields: {
      date: toYMD(d),
      content,
      start_time: st,
      end_time: et,
      period,
    },
  };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    title: '周工作日志',
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'static', 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about', label: '关于 周工作日志' },
              { type: 'separator' },
              { role: 'services', label: '服务' },
              { type: 'separator' },
              { role: 'hide', label: '隐藏 周工作日志' },
              { role: 'hideOthers', label: '隐藏其他' },
              { role: 'unhide', label: '显示全部' },
              { type: 'separator' },
              { role: 'quit', label: '退出 周工作日志' },
            ],
          },
        ]
      : []),
    {
      label: '文件',
      submenu: [
        {
          label: '导出本周 Markdown…',
          accelerator: 'CmdOrCtrl+E',
          click: () => {
            if (mainWindow) mainWindow.webContents.send('menu:export');
          },
        },
        {
          label: '打开数据目录',
          click: () => {
            ensureStore();
            shell.showItemInFolder(userDataFile());
          },
        },
        { type: 'separator' },
        isMac ? { role: 'close', label: '关闭窗口' } : { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '切换全屏' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'zoom', label: '缩放' },
        ...(isMac ? [{ type: 'separator' }, { role: 'front', label: '全部置于顶层' }] : []),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function registerIpc() {
  ipcMain.handle('store:path', () => userDataFile());

  ipcMain.handle('entries:list', (_e, week) => {
    const d = parseYMD(week) || new Date();
    const weekStart = mondayOf(d);
    const entries = entriesInWeek(loadEntries(), weekStart);
    return {
      week_start: toYMD(weekStart),
      week_end: toYMD(addDays(weekStart, 6)),
      entries,
    };
  });

  ipcMain.handle('entries:create', (_e, body) => {
    const { fields, error } = validatePayload(body);
    if (error) throw new Error(error);
    const entry = {
      id: crypto.randomUUID(),
      ...fields,
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    const entries = loadEntries();
    entries.push(entry);
    saveEntries(entries);
    return entry;
  });

  ipcMain.handle('entries:update', (_e, id, body) => {
    if (!id) throw new Error('缺少 id');
    const { fields, error } = validatePayload(body);
    if (error) throw new Error(error);
    const entries = loadEntries();
    const idx = entries.findIndex((x) => x.id === id);
    if (idx < 0) throw new Error('记录不存在');
    const merged = { ...entries[idx], ...fields, updated_at: nowIso() };
    entries[idx] = merged;
    saveEntries(entries);
    return merged;
  });

  ipcMain.handle('entries:delete', (_e, id) => {
    const entries = loadEntries();
    const next = entries.filter((x) => x.id !== id);
    if (next.length === entries.length) throw new Error('记录不存在');
    saveEntries(next);
    return { ok: true, id };
  });

  ipcMain.handle('dialog:confirmDelete', async (_e, message) => {
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      message: typeof message === 'string' && message ? message : '确定删除这条记录？',
      detail: '删除后无法恢复。',
      buttons: ['删除', '取消'],
      defaultId: 1,
      cancelId: 1,
      normalizeAccessKeys: true,
    });
    return response === 0;
  });

  ipcMain.handle('export:week', async (_e, week) => {
    const d = parseYMD(week) || new Date();
    const weekStart = mondayOf(d);
    const entries = entriesInWeek(loadEntries(), weekStart);
    const md = exportMarkdown(entries, weekStart);
    const defaultName = `week-worklog-${toYMD(weekStart)}.md`;
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: '导出本周 Markdown',
      defaultPath: path.join(app.getPath('downloads'), defaultName),
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (canceled || !filePath) return { canceled: true };
    fs.writeFileSync(filePath, md, 'utf8');
    return { canceled: false, filePath };
  });
}

app.whenReady().then(() => {
  if (process.platform === 'darwin') {
    app.setName('周工作日志');
  }
  ensureStore();
  registerIpc();
  buildMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
