# 招标管理后台

从用户提供的 `bids.zip` 导入原后台源码，保留项目台账、领件状态、截止日历、CA 管理、附件、公告发现、操作记录、导出、置顶及弃标恢复功能。应用文件保持原样，校验清单见 [`../docs/source-manifest.json`](../docs/source-manifest.json)。

## 依赖与验证

Python 使用标准库，独立功能已在 Python 3.12 验证；前端为原生 HTML/JavaScript/CSS，无需安装 npm 依赖或构建。前端测试需要 Node.js。在仓库根目录执行：

```sh
python3 -m unittest discover -s backend/tests -p 'test_*.py' -v
node --test backend/tests/test_lifecycle.cjs
node --check backend/static/app.js

export BIDS_DATA="$PWD/.local/bids-data"
python3 backend/server.py init
python3 backend/server.py backup
```

`init` 可以重复执行，未指定 `--seed` 时创建空台账。`backup` 为台账 SQLite 创建快照并保留最近 14 份；它不备份上传文件或外部账号库。`.local/` 被 Git 忽略。

## 完整登录所缺的依赖

源码包不能独立完成登录，仍需从原网站工程补齐：

- `workflow` 模块及其依赖，通过 `BIDS_AUTH_PATH` 指定目录；后台调用 `token_hash(token)`、`session(connection, token)`。
- 原官网账号数据库的初始化/迁移逻辑，包含 `console_sessions` 会话表；数据库路径通过 `INQUIRY_DB` 指定。开发环境应初始化独立测试账号库，不能提交生产账号库。

`set-password` 只创建或更新 `console_password_accounts`，不会创建账号数据库或原官网会话表。不要用空文件冒充完整认证初始化，也不要以简化认证替代原官网逻辑。

补齐上述依赖后，在仓库根目录设置以下参数。这个完整登录流程尚未在当前环境验证：

```sh
export BIDS_DATA="$PWD/.local/bids-data"
export BIDS_AUTH_PATH="/path/to/website/auth-module-directory"
export INQUIRY_DB="/path/to/initialized-test-auth.sqlite3"
export BIDS_PORT=8791
export BIDS_ORIGINS="https://bids.example.com"

# 隐藏输入密码，不要把密码写入命令行或版本库
python3 backend/server.py set-password --username admin --actor 管理员
python3 backend/server.py serve
```

服务绑定 `127.0.0.1`。对外由 HTTPS 反向代理访问 `/mgmt/bids/`，透传正确的 `Host` 和 `Origin`，二者须匹配 `BIDS_ORIGINS`。会话 Cookie 包含 `Secure`；普通 HTTP 访问不能代替完整登录验证。不要关闭这些校验来让测试通过。

服务器本机健康检查：

```sh
curl --fail --header 'Host: bids.example.com' http://127.0.0.1:8791/mgmt/bids/api/health
```

## 公告检索

```sh
python3 backend/discovery.py 软件开发 音视频 RTC
```

原程序请求 8 个公开公告栏目及 3 个 Bing RSS 查询，默认窗口 **30 天**，最多返回 **25 条**候选。`BIDS_DISCOVERY_DAYS` 调整窗口；`BIDS_DISCOVERY_SOURCES` 按来源名称或域名筛选。没有日期的 RSS 线索不会因窗口被过滤，不能直接当作已核验的新公告。

所需域名：`www.ccgp.gov.cn`、`cgzx.hdu.edu.cn`、`cz.fudan.edu.cn`、`cgzb.tyut.edu.cn`、`www.unionpayintl.com`、`www.bing.com`。登录后的采购文件及其他人工门户按[执行流程](../docs/workflows.md)办理。

仓库根目录 `config/` 是人工/执行代理的流程参考，**原程序尚未读取这些 JSON**。其中建议的 14 天窗口与程序默认 30 天不同，执行时应明确采用哪个窗口。必须检查返回的 `errors`；零候选不能证明没有项目。

## 原服务器部署脚本

`deploy_remote.py` 保留原文件。它在模块顶层直接改写 Nginx/systemd 配置并操作服务，**不能作为普通库导入或用于本地测试**。它依赖原网站 Nginx 结构、`yiyouyinli-inquiries.service`，首次部署还需要包中没有的 `initial-data/`。它不是通用安装器，执行前需针对实际服务器审阅与备份。本次未执行部署脚本或改动线上服务。

## 导入范围

未导入真实 `seed.json`、数据库、上传文件、验收截图与结果、私钥、Python 缓存或 macOS 元数据。原 README 已改写为不含具体管理员身份的说明。详见[导入与验证记录](../docs/source-import.md)。
