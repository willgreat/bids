# 招标项目管理与跟进流程

面向纯软件开发、音视频、RTC、直播、语音及智能客服项目，提供原后台源码和项目发现、公告核验、采购文件分析、台账统计流程。

| 目录 | 用途 |
| --- | --- |
| [`backend/`](backend/README.md) | Python/SQLite 后台、静态前端、公告检索程序及原服务器部署脚本 |
| [`backend/tests/`](backend/tests/) | 隔离数据测试、公告解析测试和北京时间生命周期测试 |
| [`docs/workflows.md`](docs/workflows.md) | 查询、核验、去重、领件、统计及日常更新流程 |
| [`config/`](config/) | 供人工/执行代理使用的来源与关键词参考配置 |
| [`docs/source-import.md`](docs/source-import.md) | 源码导入范围、校验和验证限制 |

## 开发与验证

Python 使用标准库；原生前端无需构建。在仓库根目录执行：

```sh
python3 -m unittest discover -s backend/tests -p 'test_*.py' -v
node --test backend/tests/test_lifecycle.cjs
node --check backend/static/app.js
```

源码已导入，但完整登录还需要原官网 `workflow` 认证模块及账号库初始化逻辑，压缩包未提供这部分。独立数据和解析测试不代替登录集成验收。数据初始化、检索和启动条件见 [`backend/README.md`](backend/README.md)。

## 执行招标查询流程

1. 以本次北京时间确定查询范围，使用关键词和公开公告来源发现候选。
2. 到官方公告核对项目编号、标包、预算、资格、采购范围、报名/领件及响应截止，并检查更正、延期和终止公告。
3. 下载公开采购文件并解析；登录、付费或现场领取须记录明确办理步骤。下载公开附件与正式领件分别记录。
4. 按项目及标包去重，保留原台账的参与决策、领件状态、历史节点和附件。
5. 按统一北京时间和生命周期规则统计，列出新增、更新、近期截止、待核实、已过期及已弃标项目。

详见[执行流程](docs/workflows.md)。可运行 `python3 backend/discovery.py 软件开发 音视频 RTC` 查询公开候选；它不会自动完成核验、报名或投标。检查返回的 `errors`，访问失败不能解释成没有项目。

`config/` 是流程参考，原后台尚未读取其中的 JSON。没有设置定时采集或 GitHub Actions 自动采集任务。

## 数据与来源

业务流程根据用户提供的“查找招标网音视频与RTC项目”对话整理；后台来自后续提供的 `bids.zip`。历史项目和验收记录不代表当前线上状态，详见[来源说明](docs/workflow-provenance.md)。

版本库不收录生产台账、真实附件、账号库、密钥和原始对话。运行数据保存在被忽略的 `.local/` 或仓库外；提交前仍需检查差异，`.gitignore` 不会移除已提交的内容。
