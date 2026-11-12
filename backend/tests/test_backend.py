"""Offline checks of the imported backend; no production records or credentials."""

import hashlib
import http.client
import json
from pathlib import Path
import secrets
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server


class BackendTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        data_patch = patch.object(server, "DATA", Path(self.directory.name))
        data_patch.start()
        self.addCleanup(data_patch.stop)
        server.initialize()

    def create_project(self, **extra):
        with server.connect() as con:
            return server.save_entity(con, "projects", {
                "title": "测试音视频软件项目", **extra,
            }, "测试操作者")

    def update_project(self, project, **changes):
        with server.connect() as con:
            return server.save_entity(con, "projects", {
                "version": project["version"], **changes,
            }, "测试操作者", project["id"])

    def test_pin_abandon_restore_preserve_project_evidence(self):
        project = self.create_project(
            stage="评估", receipt_status="已领取",
            deadlines=[{"type": "submission", "at": "2026-11-20T09:00:00+08:00"}],
        )
        with server.connect() as con:
            con.execute("BEGIN IMMEDIATE")
            attachment = server.add_file(con, project["id"], "需求.txt", b"fixture", "测试操作者")
        with server.connect() as con:
            project = server.get_entity(con, "projects", project["id"])
        pinned = self.update_project(project, pinned=True)
        abandoned = self.update_project(pinned, decision="放弃")
        restored = self.update_project(abandoned, decision="待评估")
        self.assertTrue(restored["pinned"])
        self.assertEqual(restored["stage"], "评估")
        self.assertEqual(restored["receipt_status"], "已领取")
        self.assertEqual(restored["deadlines"], project["deadlines"])
        self.assertEqual(restored["attachments"], [attachment])
        with server.connect() as con:
            persisted = server.get_entity(con, "projects", project["id"])
            actions = [row[0] for row in con.execute("SELECT action FROM activity ORDER BY id")]
        self.assertEqual(persisted, restored)
        self.assertEqual(actions[-3:], ["置顶项目", "弃标", "恢复跟进"])

    def test_stale_version_cannot_overwrite_saved_changes(self):
        original = self.create_project()
        current = self.update_project(original, notes="保留较新的修改")
        with self.assertRaises(RuntimeError):
            self.update_project(original, notes="过期窗口修改")
        with server.connect() as con:
            persisted = server.get_entity(con, "projects", original["id"])
            activity_count = con.execute("SELECT COUNT(*) FROM activity").fetchone()[0]
        self.assertEqual(persisted, current)
        self.assertEqual(activity_count, 2)

    def test_editing_deadline_preserves_unsubmitted_metadata_flags(self):
        original = self.create_project(deadlines=[{
            "type": "receipt", "at": "2026-11-12T00:00:00+08:00",
            "date_only": True, "is_current": False,
        }])
        updated = self.update_project(original, deadlines=[{
            "type": "receipt", "at": "2026-11-12T00:00:00+08:00", "label": "历史领件日期",
        }])
        self.assertTrue(updated["deadlines"][0]["date_only"])
        self.assertFalse(updated["deadlines"][0]["is_current"])

    def test_attachment_deduplication_and_filename_sanitization(self):
        project = self.create_project()
        raw = "采购需求测试数据".encode()
        with server.connect() as con:
            con.execute("BEGIN IMMEDIATE")
            first = server.add_file(con, project["id"], "../../需求.txt", raw, "测试操作者")
        with server.connect() as con:
            con.execute("BEGIN IMMEDIATE")
            second = server.add_file(con, project["id"], "需求.txt", raw, "测试操作者")
        self.assertEqual(first, second)
        self.assertEqual(first["name"], "需求.txt")
        self.assertEqual((server.DATA / "files" / first["id"]).read_bytes(), raw)
        with server.connect() as con:
            row = con.execute("SELECT COUNT(*),sha256 FROM files").fetchone()
            persisted = server.get_entity(con, "projects", project["id"])
        self.assertEqual(row[0], 1)
        self.assertEqual(row[1], hashlib.sha256(raw).hexdigest())
        self.assertEqual(persisted["version"], project["version"] + 1)

    def test_duplicate_notice_rejected_without_inserting_project(self):
        self.create_project(source_url="https://example.org/notices/one")
        with self.assertRaises(ValueError):
            self.create_project(source_url="https://example.org/notices/one")
        with server.connect() as con:
            self.assertEqual(len(server.list_entities(con, "projects")), 1)

    def test_unknown_ca_reference_rejected(self):
        with self.assertRaises(ValueError):
            self.create_project(ca_ids=["missing-certificate"])
        with server.connect() as con:
            ca = server.save_entity(con, "cas", {"name": "测试证书", "status": "有效"}, "测试操作者")
        project = self.create_project(ca_ids=[ca["id"]])
        self.assertEqual(project["ca_ids"], [ca["id"]])

    def test_validation_rejects_unsafe_or_ambiguous_input(self):
        invalid = [
            {"source_url": "javascript:alert(1)"},
            {"source_url": "https://user:credential@example.org/notice"},
            {"deadlines": [{"at": "2026-11-12T09:00:00"}]},
            {"pinned": "true"},
            {"budget": float("nan")},
            {"budget": -1},
            {"budget": True},
        ]
        for payload in invalid:
            with self.subTest(fields=list(payload)), self.assertRaises(ValueError):
                server.validate(payload, "projects")

    def test_password_hashes_are_salted_and_verify(self):
        value = secrets.token_urlsafe(24)
        first, second = server.password_hash(value), server.password_hash(value)
        self.assertNotEqual(first, second)
        self.assertTrue(server.password_matches(value, first))
        self.assertFalse(server.password_matches(value + "wrong", first))


class HTTPBoundaryTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        data_patch = patch.object(server, "DATA", Path(directory.name))
        data_patch.start()
        self.addCleanup(data_patch.stop)
        server.initialize()
        self.httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        self.httpd.daemon_threads = True
        self.port = self.httpd.server_port
        self.origin = f"http://127.0.0.1:{self.port}"
        for name, value in (("HOSTS", {f"127.0.0.1:{self.port}"}), ("ORIGINS", {self.origin})):
            change = patch.object(server, name, value)
            change.start()
            self.addCleanup(change.stop)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop_server)

    def stop_server(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=2)

    def request(self, path, method="GET", headers=None):
        con = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            con.request(method, path, body="{}" if method == "POST" else None, headers=headers or {})
            response = con.getresponse()
            return response.status, response.read(), dict(response.getheaders())
        finally:
            con.close()

    def test_health_and_static_are_available_without_auth_module(self):
        status, body, headers = self.request("/mgmt/bids/api/health")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {"ok": True})
        status, body, headers = self.request("/mgmt/bids/")
        self.assertEqual(status, 200)
        self.assertIn(b"app.js", body)
        self.assertEqual(headers["X-Frame-Options"], "DENY")

    def test_private_data_requires_login(self):
        for endpoint in ("bootstrap", "export", "projects", "attachments/" + "0" * 32):
            with self.subTest(endpoint=endpoint):
                self.assertEqual(self.request("/mgmt/bids/api/" + endpoint)[0], 401)
        status, _, _ = self.request("/mgmt/bids/api/projects", "POST", {
            "Origin": self.origin, "X-Requested-With": "XMLHttpRequest", "Content-Type": "application/json",
        })
        self.assertEqual(status, 401)

    def test_untrusted_host_and_cross_origin_mutation_rejected(self):
        self.assertEqual(self.request("/mgmt/bids/api/health", headers={"Host": "untrusted.example"})[0], 403)
        status, _, _ = self.request("/mgmt/bids/api/projects", "POST", {
            "Origin": "https://untrusted.example", "X-Requested-With": "XMLHttpRequest", "Content-Type": "application/json",
        })
        self.assertEqual(status, 403)


if __name__ == "__main__":
    unittest.main()
