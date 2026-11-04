#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""周工作日志 — 本地 HTTP 服务（仅标准库）"""

from __future__ import annotations

import json
import re
import uuid
from datetime import date, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
DATA_DIR = ROOT / "data"
DATA_FILE = DATA_DIR / "entries.json"
HOST = "127.0.0.1"
PORT = 8765

WEEKDAY_CN = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def ensure_data() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if not DATA_FILE.exists():
        DATA_FILE.write_text("[]\n", encoding="utf-8")
        seed_samples()


def load_entries() -> list:
    ensure_data()
    try:
        raw = DATA_FILE.read_text(encoding="utf-8").strip() or "[]"
        data = json.loads(raw)
        return data if isinstance(data, list) else []
    except (json.JSONDecodeError, OSError):
        return []


def save_entries(entries: list) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = DATA_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(entries, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(DATA_FILE)


def monday_of(d: date) -> date:
    return d - timedelta(days=d.weekday())


def parse_ymd(s: str) -> date | None:
    try:
        return datetime.strptime(s, "%Y-%m-%d").date()
    except (ValueError, TypeError):
        return None


def week_range(week_start: date) -> tuple[date, date]:
    return week_start, week_start + timedelta(days=6)


def entries_in_week(entries: list, week_start: date) -> list:
    start, end = week_range(week_start)
    out = []
    for e in entries:
        d = parse_ymd(e.get("date", ""))
        if d and start <= d <= end:
            out.append(e)
    out.sort(key=lambda x: (x.get("date", ""), x.get("start_time") or "", x.get("period") or "", x.get("created_at") or ""))
    return out


def seed_samples() -> None:
    today = date.today()
    mon = monday_of(today)
    samples = [
        {
            "id": str(uuid.uuid4()),
            "date": mon.isoformat(),
            "start_time": "09:00",
            "end_time": "11:30",
            "period": None,
            "content": "【示例】周会同步进度，梳理本周优先事项",
            "created_at": now_iso(),
            "updated_at": now_iso(),
        },
        {
            "id": str(uuid.uuid4()),
            "date": (mon + timedelta(days=1)).isoformat(),
            "start_time": None,
            "end_time": None,
            "period": "上午",
            "content": "【示例】排查训练日志异常，修复数据加载脚本",
            "created_at": now_iso(),
            "updated_at": now_iso(),
        },
        {
            "id": str(uuid.uuid4()),
            "date": (mon + timedelta(days=2)).isoformat(),
            "start_time": "14:00",
            "end_time": "17:00",
            "period": None,
            "content": "【示例】撰写技术方案初稿，与同事对齐接口设计",
            "created_at": now_iso(),
            "updated_at": now_iso(),
        },
    ]
    save_entries(samples)


def time_label(entry: dict) -> str:
    st, et = entry.get("start_time"), entry.get("end_time")
    period = entry.get("period")
    if st and et:
        return f"{st}–{et}"
    if st:
        return f"{st} 起"
    if period:
        return str(period)
    return "全天"


def export_markdown(entries: list, week_start: date) -> str:
    end = week_start + timedelta(days=6)
    lines = [
        f"# 周工作日志 {week_start.isoformat()} ~ {end.isoformat()}",
        "",
        "> 可直接交给智能体据此撰写一周工作汇报。",
        "",
    ]
    by_day: dict[str, list] = {}
    for e in entries:
        by_day.setdefault(e.get("date", ""), []).append(e)

    for i in range(7):
        d = week_start + timedelta(days=i)
        key = d.isoformat()
        day_entries = by_day.get(key, [])
        lines.append(f"## {WEEKDAY_CN[i]} {key}")
        lines.append("")
        if not day_entries:
            lines.append("- （无记录）")
            lines.append("")
            continue
        for e in day_entries:
            label = time_label(e)
            content = (e.get("content") or "").strip().replace("\n", "\n  ")
            lines.append(f"- **{label}**：{content}")
        lines.append("")

    lines.append("---")
    lines.append("")
    lines.append("## 本周要点（可选填写）")
    lines.append("")
    lines.append("- ")
    lines.append("")
    return "\n".join(lines)


def validate_entry_payload(body: dict, *, partial: bool = False) -> tuple[dict | None, str | None]:
    content = body.get("content")
    if not partial or "content" in body:
        if not isinstance(content, str) or not content.strip():
            return None, "内容不能为空"
        content = content.strip()

    date_s = body.get("date")
    if not partial or "date" in body:
        d = parse_ymd(date_s) if isinstance(date_s, str) else None
        if not d:
            return None, "日期格式应为 YYYY-MM-DD"
        date_s = d.isoformat()

    start_time = body.get("start_time")
    end_time = body.get("end_time")
    period = body.get("period")

    def norm_time(v):
        if v is None or v == "":
            return None
        if not isinstance(v, str):
            return False
        v = v.strip()
        if not re.fullmatch(r"\d{1,2}:\d{2}", v):
            return False
        h, m = v.split(":")
        h, m = int(h), int(m)
        if not (0 <= h <= 23 and 0 <= m <= 59):
            return False
        return f"{h:02d}:{m:02d}"

    if "start_time" in body or not partial:
        st = norm_time(start_time)
        if st is False:
            return None, "开始时间格式应为 HH:MM"
        start_time = st
    if "end_time" in body or not partial:
        et = norm_time(end_time)
        if et is False:
            return None, "结束时间格式应为 HH:MM"
        end_time = et
    if "period" in body or not partial:
        if period is None or period == "":
            period = None
        elif not isinstance(period, str):
            return None, "时段标签须为文本"
        else:
            period = period.strip() or None

    out = {}
    if not partial or "date" in body:
        out["date"] = date_s
    if not partial or "content" in body:
        out["content"] = content
    if not partial or "start_time" in body:
        out["start_time"] = start_time
    if not partial or "end_time" in body:
        out["end_time"] = end_time
    if not partial or "period" in body:
        out["period"] = period
    return out, None


class Handler(BaseHTTPRequestHandler):
    server_version = "WeekWorklog/1.0"

    def log_message(self, fmt: str, *args) -> None:
        print(f"[{datetime.now().strftime('%H:%M:%S')}] {self.address_string()} {fmt % args}")

    def _send(self, code: int, body: bytes, content_type: str, extra_headers: dict | None = None) -> None:
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if extra_headers:
            for k, v in extra_headers.items():
                self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code: int, obj) -> None:
        raw = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self._send(code, raw, "application/json; charset=utf-8")

    def _read_json(self) -> tuple[dict | None, str | None]:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}, None
        if length > 1_000_000:
            return None, "请求体过大"
        try:
            data = json.loads(self.rfile.read(length).decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            return None, "JSON 解析失败"
        if not isinstance(data, dict):
            return None, "请求体须为 JSON 对象"
        return data, None

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path

        if path in ("/", "/index.html"):
            return self._serve_static("index.html")
        if path.startswith("/static/"):
            return self._serve_static(path[len("/static/") :])
        if path == "/api/health":
            return self._json(200, {"ok": True, "service": "week-worklog"})
        if path == "/api/entries":
            return self._api_list(parsed)
        if path == "/api/export":
            return self._api_export(parsed)

        self._json(404, {"error": "未找到"})

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/entries":
            return self._api_create()
        self._json(404, {"error": "未找到"})

    def do_PUT(self) -> None:
        parsed = urlparse(self.path)
        m = re.fullmatch(r"/api/entries/([0-9a-fA-F\-]{36})", parsed.path)
        if m:
            return self._api_update(m.group(1))
        self._json(404, {"error": "未找到"})

    def do_DELETE(self) -> None:
        parsed = urlparse(self.path)
        m = re.fullmatch(r"/api/entries/([0-9a-fA-F\-]{36})", parsed.path)
        if m:
            return self._api_delete(m.group(1))
        self._json(404, {"error": "未找到"})

    def _serve_static(self, name: str) -> None:
        # prevent path traversal
        name = name.lstrip("/").replace("\\", "/")
        if ".." in name.split("/"):
            return self._json(400, {"error": "非法路径"})
        if name == "index.html":
            fp = STATIC / "index.html"
        else:
            fp = (STATIC / name).resolve()
            if not str(fp).startswith(str(STATIC.resolve())):
                return self._json(400, {"error": "非法路径"})
        if not fp.is_file():
            return self._json(404, {"error": "静态文件不存在"})
        data = fp.read_bytes()
        ctype = {
            ".html": "text/html; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".js": "application/javascript; charset=utf-8",
            ".svg": "image/svg+xml",
            ".json": "application/json; charset=utf-8",
        }.get(fp.suffix.lower(), "application/octet-stream")
        self._send(200, data, ctype)

    def _resolve_week(self, qs: dict) -> date | None:
        if "week" in qs and qs["week"]:
            d = parse_ymd(qs["week"][0])
            if d:
                return monday_of(d)
        if "date" in qs and qs["date"]:
            d = parse_ymd(qs["date"][0])
            if d:
                return monday_of(d)
        return monday_of(date.today())

    def _api_list(self, parsed) -> None:
        qs = parse_qs(parsed.query)
        week_start = self._resolve_week(qs)
        if week_start is None:
            return self._json(400, {"error": "无效的周参数"})
        entries = entries_in_week(load_entries(), week_start)
        end = week_start + timedelta(days=6)
        self._json(
            200,
            {
                "week_start": week_start.isoformat(),
                "week_end": end.isoformat(),
                "entries": entries,
            },
        )

    def _api_create(self) -> None:
        body, err = self._read_json()
        if err:
            return self._json(400, {"error": err})
        fields, err = validate_entry_payload(body or {}, partial=False)
        if err:
            return self._json(400, {"error": err})
        entry = {
            "id": str(uuid.uuid4()),
            **fields,
            "created_at": now_iso(),
            "updated_at": now_iso(),
        }
        entries = load_entries()
        entries.append(entry)
        save_entries(entries)
        self._json(201, entry)

    def _api_update(self, eid: str) -> None:
        body, err = self._read_json()
        if err:
            return self._json(400, {"error": err})
        fields, err = validate_entry_payload(body or {}, partial=True)
        if err:
            return self._json(400, {"error": err})
        entries = load_entries()
        for i, e in enumerate(entries):
            if e.get("id") == eid:
                merged = {**e, **fields, "updated_at": now_iso()}
                # re-validate content/date if missing after merge
                if not (merged.get("content") or "").strip():
                    return self._json(400, {"error": "内容不能为空"})
                if not parse_ymd(merged.get("date", "")):
                    return self._json(400, {"error": "日期无效"})
                entries[i] = merged
                save_entries(entries)
                return self._json(200, merged)
        self._json(404, {"error": "记录不存在"})

    def _api_delete(self, eid: str) -> None:
        entries = load_entries()
        new = [e for e in entries if e.get("id") != eid]
        if len(new) == len(entries):
            return self._json(404, {"error": "记录不存在"})
        save_entries(new)
        self._json(200, {"ok": True, "id": eid})

    def _api_export(self, parsed) -> None:
        qs = parse_qs(parsed.query)
        week_start = self._resolve_week(qs)
        if week_start is None:
            return self._json(400, {"error": "无效的周参数"})
        entries = entries_in_week(load_entries(), week_start)
        md = export_markdown(entries, week_start)
        fname = f"week-worklog-{week_start.isoformat()}.md"
        self._send(
            200,
            md.encode("utf-8"),
            "text/markdown; charset=utf-8",
            {"Content-Disposition": f'attachment; filename="{fname}"'},
        )


def main() -> None:
    ensure_data()
    STATIC.mkdir(parents=True, exist_ok=True)
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    print("=" * 50)
    print("  周工作日志 Week Worklog")
    print(f"  打开浏览器访问: http://{HOST}:{PORT}/")
    print(f"  数据文件: {DATA_FILE}")
    print("  按 Ctrl+C 停止")
    print("=" * 50)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")
        httpd.server_close()


if __name__ == "__main__":
    main()
