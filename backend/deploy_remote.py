#!/usr/bin/env python3
"""Install the tender service and add its routes to both website HTTPS hosts."""
from datetime import datetime, timezone
from pathlib import Path
import json
import os
import shutil
import subprocess
import sys

SITE = Path('/etc/nginx/conf.d/yiyouyinli.com.conf')
APP = Path('/var/www/yiyouyinli-mgmt/bids')
STATE = Path('/var/lib/yiyouyinli-bids')
SNIPPET = Path('/etc/nginx/snippets/yiyouyinli-bids.conf')
stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
backup = Path('/var/backups/yiyouyinli-mgmt') / stamp
backup.mkdir(parents=True, mode=0o700)
shutil.copy2(SITE, backup / SITE.name)
if SNIPPET.exists():
    shutil.copy2(SNIPPET, backup / SNIPPET.name)
if not STATE.exists():
    STATE.mkdir(mode=0o700)
if not (STATE / 'bids.sqlite3').exists():
    shutil.copytree(APP / 'initial-data', STATE, dirs_exist_ok=True)

service = '''[Unit]
Description=Yiyouyinli tender management
After=network.target yiyouyinli-inquiries.service
Requires=yiyouyinli-inquiries.service

[Service]
Type=simple
User=yiyouyinli-inquiries
DynamicUser=yes
StateDirectory=yiyouyinli-bids yiyouyinli-inquiries
StateDirectoryMode=0700
WorkingDirectory=/var/www/yiyouyinli-mgmt/bids
ExecStart=/usr/bin/python3 /var/www/yiyouyinli-mgmt/bids/server.py serve
Environment=BIDS_DATA=/var/lib/yiyouyinli-bids
Environment=INQUIRY_DB=/var/lib/yiyouyinli-inquiries/inquiries.sqlite3
Environment=PYTHONDONTWRITEBYTECODE=1
Environment=PYTHONUNBUFFERED=1
Environment=TZ=Asia/Shanghai
ReadWritePaths=/var/lib/yiyouyinli-inquiries
Restart=on-failure
RestartSec=3
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ProtectKernelTunables=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
UMask=0077
MemoryMax=256M
TasksMax=64

[Install]
WantedBy=multi-user.target
'''
Path('/etc/systemd/system/yiyouyinli-bids.service').write_text(service)
SNIPPET.write_text('''location = /mgmt { return 302 /mgmt/bids/; }
location = /mgmt/ { return 302 /mgmt/bids/; }
location ^~ /mgmt/ {
    client_max_body_size 32m;
    proxy_pass http://127.0.0.1:8791;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header Origin $http_origin;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Connection "";
    proxy_connect_timeout 5s;
    proxy_read_timeout 35s;
    proxy_send_timeout 35s;
    proxy_cache off;
    proxy_buffering off;
    access_log off;
}
''')
include = '    include /etc/nginx/snippets/yiyouyinli-bids.conf;'
content = SITE.read_text()
if include not in content:
    anchor = '    include /etc/nginx/snippets/yiyouyinli-inquiries.conf;'
    if content.count(anchor) != 2:
        raise RuntimeError('Unexpected website server configuration, review route insertion')
    SITE.write_text(content.replace(anchor, include + '\n' + anchor))
result = subprocess.run(['nginx', '-t'], capture_output=True, text=True)
if result.returncode:
    shutil.copy2(backup / SITE.name, SITE)
    if (backup / SNIPPET.name).exists():
        shutil.copy2(backup / SNIPPET.name, SNIPPET)
    print(result.stderr, file=sys.stderr)
    raise SystemExit('Nginx test failed and previous configuration was restored')
subprocess.run(['systemctl', 'daemon-reload'], check=True)
subprocess.run(['systemctl', 'enable', '--now', 'yiyouyinli-bids.service'], check=True)
subprocess.run(['systemctl', 'restart', 'yiyouyinli-bids.service'], check=True)
subprocess.run(['systemctl', 'reload', 'nginx'], check=True)

# Daily SQLite snapshots preserve edits independently of code releases.
Path('/etc/systemd/system/yiyouyinli-bids-backup.service').write_text('''[Unit]
Description=Back up tender management data
After=yiyouyinli-bids.service
[Service]
Type=oneshot
User=yiyouyinli-inquiries
DynamicUser=yes
StateDirectory=yiyouyinli-bids
Environment=BIDS_DATA=/var/lib/yiyouyinli-bids
Environment=PYTHONDONTWRITEBYTECODE=1
ExecStart=/usr/bin/python3 /var/www/yiyouyinli-mgmt/bids/server.py backup
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
UMask=0077
''')
Path('/etc/systemd/system/yiyouyinli-bids-backup.timer').write_text('''[Unit]
Description=Daily tender data snapshot
[Timer]
OnCalendar=*-*-* 03:20:00 Asia/Shanghai
Persistent=true
[Install]
WantedBy=timers.target
''')
subprocess.run(['systemctl', 'daemon-reload'], check=True)
subprocess.run(['systemctl', 'enable', '--now', 'yiyouyinli-bids-backup.timer'], check=True)
print(json.dumps({'root': str(APP), 'state': str(STATE), 'nginx_backup': str(backup), 'url': 'https://www.yiyouyinli.com/mgmt/bids'}, ensure_ascii=False))
