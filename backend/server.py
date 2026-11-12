#!/usr/bin/env python3
"""Authenticated tender workspace using website operator accounts and sessions."""
import argparse
import getpass
import hashlib
import hmac
import importlib
import json
import logging
import math
import mimetypes
import os
import re
import secrets
import shutil
import sqlite3
import sys
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from email import policy
from email.parser import BytesParser
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parent
DATA = Path(os.environ.get('BIDS_DATA', '/var/lib/yiyouyinli-bids'))
AUTH_DB = Path(os.environ.get('INQUIRY_DB', '/var/lib/yiyouyinli-inquiries/inquiries.sqlite3'))
AUTH_MODULE = os.environ.get('BIDS_AUTH_PATH', '/opt/yiyouyinli-site')
PREFIX = '/mgmt/bids'
COOKIE = 'yyyl_mgmt_session'
PORT = int(os.environ.get('BIDS_PORT', '8791'))
ORIGINS = set(os.environ.get('BIDS_ORIGINS', 'https://www.yiyouyinli.com,https://yiyouyinli.com').split(','))
HOSTS = {urlsplit(x).netloc for x in ORIGINS}
MAX_UPLOAD = 32 * 1024 * 1024
RATE = {}
RATE_LOCK = threading.Lock()
DISCOVERY_LOCK = threading.Lock()
PASSWORD_ITERATIONS = 600000
PROJECT_FIELDS = {'title', 'project_code', 'buyer', 'platform', 'region', 'budget', 'budget_tax',
                  'decision', 'receipt_status', 'stage', 'owner', 'summary', 'requirements', 'notes',
                  'source_url', 'verified_at', 'deadlines', 'materials', 'ca_ids', 'pinned'}
CA_FIELDS = {'name', 'platform', 'issuer', 'status', 'expires_at', 'holder', 'notes'}
CHOICES = {'decision': ('待评估', '参与', '暂缓', '放弃'),
           'receipt_status': ('未领取', '已申请', '已领取', '已截止'),
           'stage': ('线索', '领件', '评估', '制标', '已递交', '成交', '未成交', '已结束'),
           'status': ('未办理', '办理中', '有效', '补办中', '已过期', '待确认')}


def now():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def text(value, limit=16000):
    if not isinstance(value, str) or len(value) > limit or '\x00' in value:
        raise ValueError('文本格式或长度不正确')
    return value.strip()


def date(value):
    value = text(value, 60)
    if value:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
        if parsed.tzinfo is None:
            raise ValueError('截止时间需要时区，请使用北京时间')
    return value


def safe_url(value):
    value = text(value, 2500)
    if value:
        u = urlsplit(value)
        if u.scheme not in ('https', 'http') or not u.netloc or u.username or u.password:
            raise ValueError('来源网址必须为 HTTP 或 HTTPS 链接')
    return value


def validate(body, kind):
    fields = PROJECT_FIELDS if kind == 'projects' else CA_FIELDS
    result = {}
    for key in fields.intersection(body):
        value = body[key]
        if key in CHOICES:
            if value not in CHOICES[key]:
                raise ValueError('状态选项不正确')
        elif key == 'pinned':
            if not isinstance(value, bool):
                raise ValueError('置顶状态必须为布尔值')
        elif key == 'budget':
            if value in ('', None):
                value = None
            elif isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
                raise ValueError('预算必须为非负金额')
        elif key == 'deadlines':
            if not isinstance(value, list) or len(value) > 40:
                raise ValueError('截止时间列表不正确')
            value = [{'label': text(x.get('label', ''), 100), 'type': text(x.get('type', ''), 80),
                      'at': date(x.get('at', '')), 'source': text(x.get('source', ''), 2500),
                      'note': text(x.get('note', ''), 2000), 'date_only': x.get('date_only') is True,
                      'is_current': x.get('is_current') is not False} for x in value if isinstance(x, dict)]
        elif key == 'materials':
            if not isinstance(value, list) or len(value) > 100:
                raise ValueError('材料清单不正确')
            value = [{'label': text(x.get('label', ''), 500), 'done': x.get('done') is True}
                     for x in value if isinstance(x, dict)]
        elif key == 'ca_ids':
            if not isinstance(value, list) or len(value) > 30:
                raise ValueError('CA 关联不正确')
            value = list(dict.fromkeys(text(x, 100) for x in value))
        elif key == 'source_url':
            value = safe_url(value)
        elif key == 'verified_at':
            value = date(value)
        elif key == 'expires_at':
            value = text(value, 40)
            if value:
                datetime.fromisoformat(value.replace('Z', '+00:00'))
        else:
            value = text(value)
        result[key] = value
    return result


@contextmanager
def connect():
    con = sqlite3.connect(DATA / 'bids.sqlite3', timeout=10)
    con.row_factory = sqlite3.Row
    con.execute('PRAGMA foreign_keys=ON')
    try:
        with con:
            yield con
    finally:
        con.close()


def record(con, actor, action, title, entity_id=''):
    con.execute('INSERT INTO activity(actor,action,title,entity_id,at) VALUES(?,?,?,?,?)',
                (actor, action, title, entity_id, now()))


def get_entity(con, kind, entity_id):
    row = con.execute(f'SELECT data,version FROM {kind} WHERE id=?', (entity_id,)).fetchone()
    if row is None:
        raise LookupError('记录不存在')
    defaults = {'pinned': False} if kind == 'projects' else {}
    return {**defaults, **json.loads(row['data']), 'version': row['version']}


def list_entities(con, kind):
    defaults = {'pinned': False} if kind == 'projects' else {}
    return [{**defaults, **json.loads(r['data']), 'version': r['version']}
            for r in con.execute(f'SELECT data,version FROM {kind} ORDER BY updated_at DESC,id')]


def save_entity(con, kind, body, actor, entity_id=None):
    con.execute('BEGIN IMMEDIATE')
    changes = validate(body, kind)
    action = '更新项目' if kind == 'projects' else '更新 CA'
    if kind == 'projects':
        ca_ids = changes.get('ca_ids', [])
        if any(not con.execute('SELECT 1 FROM cas WHERE id=?', (x,)).fetchone() for x in ca_ids):
            raise ValueError('关联的 CA 不存在')
    if entity_id:
        old = get_entity(con, kind, entity_id)
        if body.get('version') != old['version']:
            raise RuntimeError('记录已被其他窗口修改，请刷新后重新编辑')
        if kind == 'projects':
            if changes.get('decision') == '放弃' and old.get('decision') != '放弃':
                action = '弃标'
            elif old.get('decision') == '放弃' and 'decision' in changes and changes['decision'] != '放弃':
                action = '恢复跟进'
            elif 'pinned' in changes and changes['pinned'] != old.get('pinned', False):
                action = '置顶项目' if changes['pinned'] else '取消置顶'
        if kind == 'projects' and 'deadlines' in changes:
            submitted = [x for x in body['deadlines'] if isinstance(x, dict)]
            for raw, deadline in zip(submitted, changes['deadlines']):
                previous = [x for x in old.get('deadlines', [])
                            if x.get('type', '') == deadline['type'] and x.get('at', '') == deadline['at']]
                if len(previous) == 1:
                    for flag in ('date_only', 'is_current'):
                        if flag not in raw and flag in previous[0]:
                            deadline[flag] = previous[0][flag]
        data = {**old, **changes, 'updated_at': now()}
        version = old['version'] + 1
    else:
        if not changes.get('title' if kind == 'projects' else 'name'):
            raise ValueError('请填写名称')
        entity_id = secrets.token_hex(12)
        defaults = {'decision': '待评估', 'receipt_status': '未领取', 'stage': '线索', 'owner': actor,
                    'deadlines': [], 'materials': [], 'ca_ids': [], 'attachments': [], 'pinned': False} if kind == 'projects' else {'status': '待确认'}
        if kind == 'projects' and changes.get('source_url') and urlsplit(changes['source_url']).path not in ('', '/'):
            row = con.execute("SELECT data FROM projects WHERE json_extract(data,'$.source_url')=?", (changes['source_url'],)).fetchone()
            if row:
                raise ValueError('此来源链接已经入库，请在项目台账中查看')
        data = {**defaults, **changes, 'id': entity_id, 'created_at': now(), 'updated_at': now()}
        version = 1
    data.pop('version', None)
    if not data.get('title' if kind == 'projects' else 'name'):
        raise ValueError('名称不能为空')
    con.execute(f'INSERT INTO {kind}(id,data,version,updated_at) VALUES(?,?,?,?) '
                'ON CONFLICT(id) DO UPDATE SET data=excluded.data,version=excluded.version,updated_at=excluded.updated_at',
                (entity_id, json.dumps(data, ensure_ascii=False), version, data['updated_at']))
    record(con, actor, action, data.get('title', data.get('name')), entity_id)
    return {**data, 'version': version}


def initialize(seed=None):
    DATA.mkdir(mode=0o700, parents=True, exist_ok=True)
    (DATA / 'files').mkdir(mode=0o700, exist_ok=True)
    with connect() as con:
        con.execute('PRAGMA journal_mode=WAL')
        for kind in ('projects', 'cas'):
            con.execute(f'CREATE TABLE IF NOT EXISTS {kind}(id TEXT PRIMARY KEY,data TEXT NOT NULL,version INTEGER NOT NULL,updated_at TEXT NOT NULL)')
        con.executescript('''
          CREATE TABLE IF NOT EXISTS activity(id INTEGER PRIMARY KEY,actor TEXT,action TEXT,title TEXT,entity_id TEXT,at TEXT);
          CREATE TABLE IF NOT EXISTS files(id TEXT PRIMARY KEY,project_id TEXT REFERENCES projects(id),name TEXT,size INTEGER,sha256 TEXT,uploaded_at TEXT);
        ''')
        if seed:
            data = json.loads(Path(seed).read_text())
            for kind in ('cas', 'projects'):
                for item in data.get(kind, []):
                    clean = validate(item, kind)
                    entity_id = item['id']
                    clean.update(id=entity_id, created_at=now(), updated_at=now())
                    if kind == 'projects':
                        clean['attachments'] = []
                    inserted = con.execute(f'INSERT OR IGNORE INTO {kind} VALUES(?,?,1,?)',
                                           (entity_id, json.dumps(clean, ensure_ascii=False), clean['updated_at'])).rowcount
                    if inserted:
                        record(con, '历史资料', '导入项目' if kind == 'projects' else '导入 CA', clean.get('title', clean.get('name')), entity_id)
    os.chmod(DATA / 'bids.sqlite3', 0o600)


def add_file(con, project_id, filename, raw, actor):
    project = get_entity(con, 'projects', project_id)
    name = Path(filename.replace('\\', '/')).name
    name = text(name, 240)
    if not name or any(ord(c) < 32 for c in name):
        raise ValueError('文件名不正确')
    allowed = {'.pdf', '.doc', '.docx', '.xls', '.xlsx', '.csv', '.txt', '.html', '.zip', '.zcx', '.zgdxnzf', '.jpg', '.jpeg', '.png'}
    if Path(name).suffix.lower() not in allowed:
        raise ValueError('支持采购文件、表格、压缩包、图片及文本')
    digest = hashlib.sha256(raw).hexdigest()
    existing = con.execute('SELECT id FROM files WHERE project_id=? AND sha256=? AND name=?', (project_id, digest, name)).fetchone()
    if existing:
        return next(x for x in project['attachments'] if x['id'] == existing['id'])
    file_id = secrets.token_hex(16)
    path = DATA / 'files' / file_id
    with path.open('xb') as handle:
        os.chmod(path, 0o600)
        handle.write(raw)
        handle.flush()
        os.fsync(handle.fileno())
    meta = {'id': file_id, 'name': name, 'size': len(raw), 'uploaded_at': now()}
    try:
        con.execute('INSERT INTO files VALUES(?,?,?,?,?,?)', (file_id, project_id, name, len(raw), digest, meta['uploaded_at']))
        project['attachments'].append(meta)
        project.pop('version', None)
        project['updated_at'] = now()
        con.execute('UPDATE projects SET data=?,version=version+1,updated_at=? WHERE id=?',
                    (json.dumps(project, ensure_ascii=False), project['updated_at'], project_id))
        record(con, actor, '上传附件', name, project_id)
    except Exception:
        path.unlink(missing_ok=True)
        raise
    return meta


def workflow_module():
    if AUTH_MODULE not in sys.path:
        sys.path.insert(0, AUTH_MODULE)
    return importlib.import_module('workflow')


def initialize_password_accounts():
    with sqlite3.connect(f'file:{AUTH_DB}?mode=rw', uri=True, timeout=5) as con:
        con.execute('''CREATE TABLE IF NOT EXISTS console_password_accounts (
            username TEXT PRIMARY KEY, password_hash TEXT NOT NULL, actor TEXT NOT NULL)''')


def password_hash(password):
    if not isinstance(password, str) or not 0 < len(password.encode('utf-8')) <= 1024:
        raise ValueError('请输入不超过1024字节的密码')
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt, PASSWORD_ITERATIONS)
    return f'pbkdf2_sha256${PASSWORD_ITERATIONS}${salt.hex()}${digest.hex()}'


def password_matches(password, encoded):
    algorithm, iterations, salt, expected = encoded.split('$')
    if algorithm != 'pbkdf2_sha256':
        raise ValueError('密码存储格式不正确')
    actual = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), bytes.fromhex(salt), int(iterations))
    return hmac.compare_digest(actual, bytes.fromhex(expected))


def password_login(con, username, password):
    valid = (isinstance(username, str) and 0 < len(username.strip()) <= 80
             and isinstance(password, str) and 0 < len(password.encode('utf-8')) <= 1024)
    con.execute('BEGIN IMMEDIATE')
    row = con.execute('SELECT password_hash,actor FROM console_password_accounts WHERE username=?',
                      (username.strip() if valid else '',)).fetchone()
    encoded = row[0] if row else f'pbkdf2_sha256${PASSWORD_ITERATIONS}${"00" * 16}${"00" * 32}'
    matches = password_matches(password if valid else '', encoded)
    if not valid or not row or not matches:
        raise ValueError('用户名或密码错误')
    token = secrets.token_urlsafe(32)
    csrf = secrets.token_urlsafe(32)
    expires = int(time.time()) + 3600
    con.execute('DELETE FROM console_sessions WHERE expires<=?', (int(time.time()),))
    con.execute('INSERT INTO console_sessions(digest,actor,csrf,expires) VALUES(?,?,?,?)',
                (workflow_module().token_hash(token), row[1], csrf, expires))
    return token, row[1]


class Handler(BaseHTTPRequestHandler):
    server_version = 'YiyouyinliMgmt'

    def log_message(self, fmt, *args):
        logging.info('%s %s', self.command, self.path.split('?')[0])

    def send(self, status, data, mime='application/json; charset=utf-8', cookie=None, disposition=None):
        raw = json.dumps(data, ensure_ascii=False).encode() if not isinstance(data, bytes) else data
        self.send_response(status)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(raw)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('X-Frame-Options', 'DENY')
        self.send_header('Referrer-Policy', 'same-origin')
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
        if cookie:
            self.send_header('Set-Cookie', cookie)
        if disposition:
            self.send_header('Content-Disposition', disposition)
        self.end_headers()
        self.wfile.write(raw)

    def token(self):
        try:
            cookies = SimpleCookie(self.headers.get('Cookie', ''))
            return cookies[COOKIE].value if COOKIE in cookies else ''
        except Exception:
            return ''

    def auth(self):
        token = self.token()
        if not token:
            return None
        with sqlite3.connect(f'file:{AUTH_DB}?mode=ro', uri=True, timeout=5) as con:
            return workflow_module().session(con, token)

    def trusted(self):
        return self.client_address[0] == '127.0.0.1' and self.headers.get('Host') in HOSTS

    def body(self, max_bytes=256000):
        if self.headers.get('Transfer-Encoding'):
            raise ValueError('不支持分块上传')
        size = int(self.headers.get('Content-Length', '0'))
        if not 0 < size <= max_bytes:
            raise ValueError('请求大小超出限制')
        raw = self.rfile.read(size)
        if len(raw) != size:
            raise ValueError('请求不完整')
        return raw

    def json_body(self):
        if self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
            raise ValueError('需要 JSON 请求')
        value = json.loads(self.body())
        if not isinstance(value, dict):
            raise ValueError('请求格式不正确')
        return value

    def do_GET(self):
        try:
            self.read_request()
        except (BrokenPipeError, ConnectionResetError):
            pass
        except LookupError as exc:
            self.send(404, {'error': str(exc)})
        except Exception:
            logging.exception('Read failed')
            self.send(503, {'error': '服务暂时不可用，请稍后重试'})

    def read_request(self):
        if not self.trusted():
            return self.send(403, {'error': '访问来源不正确'})
        path = urlsplit(self.path).path
        static = {PREFIX: 'index.html', PREFIX + '/': 'index.html',
                  PREFIX + '/app.js': 'app.js', PREFIX + '/styles.css': 'styles.css',
                  PREFIX + '/assets/brand-mark.svg': 'assets/brand-mark.svg',
                  PREFIX + '/assets/login-connection.webp': 'assets/login-connection.webp'}
        if path in static:
            file = ROOT / 'static' / static[path]
            mime = {'.webp': 'image/webp', '.svg': 'image/svg+xml'}.get(file.suffix)
            mime = mime or mimetypes.guess_type(file.name)[0] or 'application/octet-stream'
            if mime.startswith('text/') or mime == 'image/svg+xml':
                mime += '; charset=utf-8'
            return self.send(200, file.read_bytes(), mime)
        if path == PREFIX + '/api/health':
            with connect() as con:
                con.execute('SELECT 1 FROM projects LIMIT 1').fetchone()
            return self.send(200, {'ok': True})
        auth = self.auth()
        if not auth:
            return self.send(401, {'error': '请使用用户名和密码登录'})
        with connect() as con:
            if path in (PREFIX + '/api/bootstrap', PREFIX + '/api/export'):
                data = {'projects': list_entities(con, 'projects'), 'cas': list_entities(con, 'cas'),
                        'activity': [dict(r) for r in con.execute('SELECT * FROM activity ORDER BY id DESC LIMIT 300')],
                        'user': {'name': auth['actor'], 'actor': auth['actor']},
                        'settings': {'timezone': 'Asia/Shanghai', 'company': '北京亿有引力科技有限责任公司', 'auth': '用户名密码登录'}, 'exported_at': now()}
                return self.send(200, data, disposition='attachment; filename="bids-export.json"' if path.endswith('/export') else None)
            if path == PREFIX + '/api/projects':
                return self.send(200, list_entities(con, 'projects'))
            match = re.fullmatch(PREFIX + '/api/attachments/([a-f0-9]{32})', path)
            if match:
                row = con.execute('SELECT * FROM files WHERE id=?', (match[1],)).fetchone()
                if not row:
                    raise LookupError('附件不存在')
                from urllib.parse import quote
                disposition = "attachment; filename*=UTF-8''" + quote(row['name'])
                return self.send(200, (DATA / 'files' / row['id']).read_bytes(), 'application/octet-stream', disposition=disposition)
        raise LookupError('页面不存在')

    def do_POST(self):
        self.write_request()

    def do_PATCH(self):
        self.write_request()

    def write_request(self):
        try:
            if not self.trusted() or self.headers.get('Origin') not in ORIGINS or self.headers.get('X-Requested-With') != 'XMLHttpRequest':
                return self.send(403, {'error': '请在管理页面内操作'})
            path = urlsplit(self.path).path
            if path == PREFIX + '/api/login' and self.command == 'POST':
                return self.login()
            auth = self.auth()
            if not auth:
                return self.send(401, {'error': '登录已过期，请重新登录'})
            if path == PREFIX + '/api/logout':
                with sqlite3.connect(AUTH_DB, timeout=5) as con:
                    con.execute('DELETE FROM console_sessions WHERE digest=?', (workflow_module().token_hash(self.token()),))
                return self.send(200, {'ok': True}, cookie=f'{COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/mgmt/; Max-Age=0')
            if path == PREFIX + '/api/discover' and self.command == 'POST':
                data = self.json_body()
                query = text(data.get('query', '软件开发 音视频 RTC 智能客服'), 200)
                import discovery
                if not DISCOVERY_LOCK.acquire(blocking=False):
                    return self.send(429, {'error': '已有公告检索正在进行，请等待完成'})
                try:
                    results = discovery.discover(query)
                finally:
                    DISCOVERY_LOCK.release()
                with connect() as con:
                    record(con, auth['actor'], '检索公告', query)
                return self.send(200, results)
            match = re.fullmatch(PREFIX + '/api/(projects|cas)(?:/([a-zA-Z0-9_-]{1,100}))?', path)
            if match:
                if (match[2] and self.command != 'PATCH') or (not match[2] and self.command != 'POST'):
                    return self.send(405, {'error': '请求方法不正确'})
                data = self.json_body()
                with connect() as con:
                    result = save_entity(con, match[1], data, auth['actor'], match[2])
                return self.send(200 if match[2] else 201, result)
            match = re.fullmatch(PREFIX + '/api/projects/([a-zA-Z0-9_-]{1,100})/attachments', path)
            if match and self.command == 'POST':
                raw = self.body(MAX_UPLOAD)
                content_type = self.headers.get('Content-Type', '')
                if not content_type.startswith('multipart/form-data;'):
                    raise ValueError('需要选择上传文件')
                message = BytesParser(policy=policy.default).parsebytes(('Content-Type: ' + content_type + '\r\nMIME-Version: 1.0\r\n\r\n').encode() + raw)
                parts = [part for part in message.iter_parts() if part.get_filename()] if message.is_multipart() else []
                if len(parts) != 1:
                    raise ValueError('请每次上传一个文件')
                with connect() as con:
                    con.execute('BEGIN IMMEDIATE')
                    result = add_file(con, match[1], parts[0].get_filename(), parts[0].get_payload(decode=True), auth['actor'])
                return self.send(201, result)
            self.send(404, {'error': '接口不存在'})
        except RuntimeError as exc:
            self.send(409, {'error': str(exc)})
        except LookupError as exc:
            self.send(404, {'error': str(exc)})
        except (ValueError, TypeError) as exc:
            self.send(400, {'error': str(exc) or '请求格式不正确'})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            logging.exception('Write failed')
            self.send(503, {'error': '服务暂时不可用，请稍后重试'})

    def login(self):
        data = self.json_body()
        ip = self.headers.get('X-Real-IP', self.client_address[0])
        with RATE_LOCK:
            stamps = [x for x in RATE.get(ip, []) if x > time.time() - 300]
            if len(stamps) >= 10:
                return self.send(429, {'error': '尝试过于频繁，请五分钟后再试'})
            stamps.append(time.time())
            RATE[ip] = stamps
        try:
            with sqlite3.connect(f'file:{AUTH_DB}?mode=rw', uri=True, timeout=5) as con:
                token, actor = password_login(con, data.get('username'), data.get('password'))
        except ValueError:
            return self.send(401, {'error': '用户名或密码错误'})
        with RATE_LOCK:
            RATE.pop(ip, None)
        cookie = f'{COOKIE}={token}; HttpOnly; Secure; SameSite=Strict; Path=/mgmt/; Max-Age=3600'
        return self.send(200, {'ok': True, 'user': {'name': actor, 'actor': actor}}, cookie=cookie)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=('serve', 'init', 'import-files', 'backup', 'set-password'), nargs='?', default='serve')
    parser.add_argument('--seed')
    parser.add_argument('--username')
    parser.add_argument('--actor')
    parser.add_argument('--password-stdin', action='store_true')
    args = parser.parse_args()
    if args.command == 'set-password':
        if not args.username or not args.actor:
            parser.error('设置账号需要 --username 和 --actor')
        username = text(args.username, 80)
        actor = text(args.actor, 80)
        if not username or not actor:
            parser.error('用户名和显示名称不能为空')
        password = sys.stdin.readline().rstrip('\r\n') if args.password_stdin else getpass.getpass('新密码：')
        encoded = password_hash(password)
        initialize_password_accounts()
        with sqlite3.connect(f'file:{AUTH_DB}?mode=rw', uri=True, timeout=5) as con:
            con.execute('BEGIN IMMEDIATE')
            con.execute('''INSERT INTO console_password_accounts VALUES(?,?,?)
                ON CONFLICT(username) DO UPDATE SET password_hash=excluded.password_hash,actor=excluded.actor''',
                        (username, encoded, actor))
        print(f'已设置账号 {username} 的密码')
        return
    initialize(args.seed)
    if args.command == 'init':
        return
    if args.command == 'import-files':
        payload = json.loads(Path(args.seed).read_text())
        for item in payload['projects']:
            for file in item.get('source_files', []):
                p = Path(file)
                if p.is_file() and p.stat().st_size < MAX_UPLOAD:
                    with connect() as con:
                        con.execute('BEGIN IMMEDIATE')
                        add_file(con, item['id'], p.name, p.read_bytes(), '采购原件导入')
        return
    if args.command == 'backup':
        backups = DATA / 'backups'
        backups.mkdir(mode=0o700, exist_ok=True)
        target = backups / (datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '.sqlite3')
        with connect() as con, sqlite3.connect(target) as dest:
            con.backup(dest)
        os.chmod(target, 0o600)
        for old in sorted(backups.glob('*.sqlite3'))[:-14]:
            old.unlink()
        return
    logging.basicConfig(level=logging.INFO)
    initialize_password_accounts()
    server = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    server.daemon_threads = True
    server.serve_forever()


if __name__ == '__main__':
    main()
