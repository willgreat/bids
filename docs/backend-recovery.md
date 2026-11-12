# Backend source recovery audit

> Historical audit of the conversation export. The user subsequently supplied `bids.zip`; the application source is now in `backend/`. See [current import status](source-import.md). The missing-source statements below describe the earlier conversation-only input, not the current repository. External website authentication dependencies remain missing.

The uploaded Markdown conversation records code writes and file reads by filename and line-count summaries only. It does not include the bodies of `server.py`, `discovery.py`, `deploy_remote.py`, `static/app.js`, `static/index.html`, or `static/styles.css`. Exact recovery of the original deployed backend is therefore not possible from this export alone. Embedded executable snippets are operational/test commands, not a complete codebase. No snippets from the export were executed.

## Observed structure

Original project subdirectory: `mgmt/bids/`

- `server.py`: Python HTTP service and CLI, SQLite persistence.
- `discovery.py`: online procurement search.
- `deploy_remote.py`: deployment helper (source not present).
- `seed.json`: project and CA seed data (business data, not recovered).
- `static/index.html`, `static/app.js`, `static/styles.css`.
- `static/assets/brand-mark.svg`, `static/assets/login-connection.webp`.
- `README.md`, `.gitignore`; legacy login-code helper later superseded by password login.

CLI commands observed: `python3 server.py init --seed seed.json`, `import-files --seed seed.json`, `serve --seed seed.json`. Environment names observed: `BIDS_DATA`, `BIDS_PORT`, `BIDS_ORIGINS`; original auth dependency used `BIDS_AUTH_PATH` and `INQUIRY_DB`. Do not assume external original auth code is available.

## API contract observed in historical verification snippets

Base path: `/mgmt/bids/api`.

| Route | Behavior |
| --- | --- |
| GET `/health` | Public health response |
| POST `/login` | Latest version uses username/password; earlier one-time-code flow was superseded |
| POST `/logout` | Invalidate session |
| GET `/bootstrap` | Authenticated `{projects, cas, user}`; unauthenticated 401 |
| POST `/projects` | Create, HTTP 201 |
| PATCH `/projects/:id` | Update requires current `version`; stale version returns 409 |
| POST `/projects/:id/attachments` | Multipart upload, HTTP 201 |
| GET `/attachments/:id` | Authenticated download preserving bytes |
| POST `/cas` | Create CA record, HTTP 201 |
| PATCH `/cas/:id` | Versioned CA update |
| POST `/discover` | Body contains `query`; results need verification before import |
| GET `/export` | Export ledger |

Mutations reject unauthorized Origin. Source URLs reject unsafe schemes. Datetimes without a timezone are rejected. Only date values are supported via `date_only`. Historical tests exercised these contracts, but their old PASS claims do not validate any new implementation.

SQLite observed tables include `projects` and `cas` with `id` and `data` JSON columns. Other tables are not fully evidenced; do not assert identical DB compatibility.

## Required behavior evidenced by latest requested changes

- Project ledger: title, project code, source URL, buyer/platform, budget, qualification and delivery requirements, participation decision, receipt status, deadlines, notes, attachments and CA associations.
- Participation decisions: pending evaluation, participate, defer, abandon.
- Pin/unpin persists; pinned projects sort first.
- Abandoned projects disappear from active list, expired list and calendar, remain recoverable in an abandoned view. Restore recomputes normal/expired placement without deleting files/deadlines.
- Deadline calendar and near-term tasks.
- CA status, expiration and project associations.
- Activity records, data export and daily DB backup.
- Search failures (login wall, 403 etc.) are visible with official-source links; search results require qualification/deadline verification before import.
- Attachment receipt must distinguish downloaded public files from completed supplier registration/formal document receipt.

## Lifecycle rules from latest design and command snippets

Use Asia/Shanghai and only `is_current != false` deadlines. Past final submission deadline expires an unsubmitted project. A project whose receipt deadline passed is expired if documents were not obtained, but applications waiting review remain active and explicitly awaiting confirmation. Received documents with future submission remain active. Submitted projects remain active while awaiting results. Closed/awarded/non-awarded projects are historical. Auxiliary clarification deadlines do not expire the whole project. Unknown deadlines remain active with an explicit unknown state. A date-only deadline expires at next local midnight. A formal extension changes current deadline while retaining old historical evidence. Abandonment takes precedence over other lifecycle groups. Filtering statistics and calendar must use the same rules.

## Source evidence locations

Export lines 30536–30661 describe original deployment request and file-write summaries. Lines 30706–30730 and 30800–30818 contain interface checks. Lines 32339–32351 summarize initial features. Lines 34213–34254 define lifecycle rules. Lines 34424–34440 verify date-only/current fields. Lines 37513–37535 contain lifecycle inventory code. Lines 39523–39562 and 42448–42453 describe latest pin/abandon behavior.

## Publication boundary

The export contains plaintext historical login credentials, contact/identity details, financial and registration materials, server paths and operational access details. Do not commit the raw export, credentials, business data, private attachments or unreviewed operational commands. Use a new local secure initialization mechanism rather than embedding the exported credential. Do not describe a reimplementation as recovered original production source.

## Importing the original source later

1. Export only the application source subdirectory `mgmt/bids` from the local project, or obtain those source files from the deployed application directory through an authorized channel. A conversation export does not contain them.
2. Include `server.py`, `discovery.py`, `deploy_remote.py`, `static/index.html`, `static/app.js`, `static/styles.css`, and the existing `README.md`. Include `static/assets/brand-mark.svg` and `static/assets/login-connection.webp` if the pages reference them and their redistribution is intended. Include dependency manifests and lockfiles if they exist in the actual source checkout; their presence is not established by the conversation.
3. Review `seed.json`, `.gitignore`, and any legacy `get-login-code.sh` separately. Replace business seeds with empty or explicitly fictitious sample data before publication. Do not import databases, database backups, `verification` screenshots, uploads, supplier documents, authentication stores, `.env` files, private keys, certificates or logs. Do not copy a whole operational directory blindly.
4. Import the reviewed files under this repository's `backend/`, preserving static asset paths. Do not overwrite an existing file without reviewing its diff. Keep production data outside the source tree.
5. Read actual startup and deployment dependencies, resolve path/configuration assumptions, and retain the deployed password-login behavior without hardcoding any credential from the conversation. Any external original auth module must be supplied or deliberately replaced as a separate reviewed change.
6. Validate the imported code using isolated temporary data: startup/health, unauthenticated access denial, login/logout, project CRUD, version conflict, deadline/lifecycle cases, CA updates, attachment upload/download, pin/unpin, abandon/restore, statistics and discovery failure handling. Confirm no production records are touched.
7. Review the staged file list and diff for credentials and personal/business data, then commit and push the source. Record the source version and test results; do not claim migration of production projects or attachments unless separately performed and verified.
