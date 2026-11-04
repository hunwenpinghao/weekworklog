# 周工作日志

macOS Electron 周历工作日志（飞书风格周视图）。

- **仓库**：[hunwenpinghao/weekworklog](https://github.com/hunwenpinghao/weekworklog)
- **下载**： [Releases · v1.1.5](https://github.com/hunwenpinghao/weekworklog/releases/tag/v1.1.5)（DMG：[`WeekWorklog-1.1.5.dmg`](https://github.com/hunwenpinghao/weekworklog/releases/download/v1.1.5/WeekWorklog-1.1.5.dmg)）

完整的 Mac 桌面应用（Electron）。界面参考飞书日历周视图：在格子上**点击或拖选**时间即可记事，色块直接显示在日历上；周末可导出 Markdown 交给智能体写周报。

## 怎么打开

双击任一处即可：

- **桌面**：`~/Desktop/周工作日志.app`
- **用户 Applications**：`~/Applications/周工作日志.app`
- **工程产物**：`~/Projects/week-worklog/dist/mac/周工作日志.app`
- **安装包**：`~/Desktop/周工作日志-1.1.5.dmg` 或 `dist/周工作日志-1.1.5.dmg`

也可拖到系统「应用程序」文件夹，再固定到程序坞。

### 首次打开被 Gatekeeper 拦截？

未签名应用可能提示「无法打开，因为无法验证开发者」：

1. 在 Finder 中 **右键** 点击 `周工作日志.app` → **打开** → 再点 **打开**
2. 或：系统设置 → 隐私与安全性 → 仍要打开

## 功能（v1.1.5）

- **飞书风格周视图**：左侧迷你月历；右侧 7 列（周一～周日）× 时间轴；列头数字为周内序号 1～7（顶栏仍显示真实日期范围）
- **点选 / 拖选格子新建**：松开后弹出标题与备注输入，保存后以色块显示在对应时段
- **点击色块**：编辑或删除
- **今天 / 上一周 / 下一周**，以及 **日 / 周 / 月** 视图切换（月视图可点日期进入日视图）
- **当前时间红线**（当天）
- **导出 Markdown**（按钮或菜单「文件 → 导出本周 Markdown…」/ ⌘E）
- 兼容旧版 `entries.json`（`date` / `start_time` / `end_time` / `period` / `content`）；仅有「上午/下午/晚上/全天」标签的记录会映射到大致时段或全天行

## 数据在哪

保存在本机 Electron 用户目录：

```
~/Library/Application Support/周工作日志/entries.json
```

首次启动会自动把工程里旧的 `data/entries.json`（若存在）迁移过来。

菜单 **文件 → 打开数据目录** 可在 Finder 中定位该文件。

## 开发与重新打包

```bash
cd ~/Projects/week-worklog
# 如遇 npm 代理问题，使用临时配置：
# echo -e 'registry=https://registry.npmmirror.com\nprefix=/Users/aibee/.npm-global' > /tmp/npmrc-noproxy
npm install --userconfig /tmp/npmrc-noproxy
npm start          # 开发运行
npm run dist       # 打包 .app + .dmg 到 dist/
```

打包后可覆盖安装：

```bash
rm -rf ~/Desktop/周工作日志.app ~/Applications/周工作日志.app
cp -R dist/mac/周工作日志.app ~/Desktop/
cp -R dist/mac/周工作日志.app ~/Applications/
cp -f dist/周工作日志-*.dmg ~/Desktop/
```

## 备用：Python 网页版

`app.py` 仍可作为本地 HTTP 备用（默认 `http://127.0.0.1:8765/`），主推桌面 `.app`。

注意：网页版读写的是工程目录 `data/entries.json`，与桌面应用的用户目录 **不是同一份文件**。

- **应用图标**：圆角日历卡 + 蓝白周列意象（`build/icon.icns`，由 Pillow 生成完整 iconset）

