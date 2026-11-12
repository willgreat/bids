"""Synthetic procurement fixtures; these checks do not contact any website."""

from datetime import datetime, timedelta
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import discovery


class DiscoveryTests(unittest.TestCase):
    def test_list_keeps_each_notices_own_date(self):
        html = '''<ul>
        <li><a href="/notices/one.html">音视频软件开发采购公告</a><span>2026-11-12</span></li>
        <li><a href="/notices/two.html">语音软件开发采购公告</a><span>2026-11-10</span></li>
        <li><a href="/notices/result.html">音视频软件开发中标结果公告</a><span>2026-11-12</span></li>
        </ul>'''
        items = discovery.parse_list(html, "https://example.org/", "测试采购平台", ["软件"])
        self.assertEqual(len(items), 2)
        self.assertEqual([x["published_at"] for x in items], ["2026-11-12", "2026-11-10"])
        self.assertTrue(all(x["discovery_status"] == "待核实" for x in items))

    def test_shared_container_date_is_not_assigned_to_undated_notice(self):
        html = '''<div><time>2026-11-12</time>
        <a href="/one.html">音视频软件开发采购公告</a>
        <a href="/two.html">语音软件开发采购公告</a></div>'''
        items = discovery.parse_list(html, "https://example.org/", "测试", ["软件"])
        self.assertEqual(len(items), 2)
        self.assertEqual([x["published_at"] for x in items], ["", ""])

    def test_feed_index_date_is_not_claimed_as_publication_date(self):
        xml = '''<rss><channel><item><title>音视频软件开发采购公告</title>
        <link>https://example.org/notice.html</link>
        <pubDate>Thu, 12 Nov 2026 12:00:00 GMT</pubDate>
        <description>检索索引摘要</description></item></channel></rss>'''
        item = discovery.parse_feed(xml, "https://example.org/rss", ["软件"])[0]
        self.assertEqual(item["published_at"], "")
        self.assertEqual(item["discovery_status"], "待核实")
        self.assertIn("转载需核对", item["platform"])

    def test_url_filter_rejects_local_links_and_credentials(self):
        for url in ("javascript:alert(1)", "http://127.0.0.1/x", "http://10.1.2.3/x", "http://user:credential@example.org/x"):
            with self.subTest(url=url):
                self.assertIsNone(discovery.public_url(url, "https://example.org/"))
        self.assertEqual(discovery.public_url("/notice.html#section", "https://example.org/"), "https://example.org/notice.html")

    def test_discovery_prefers_dated_notice_dedupes_and_filters_old_items(self):
        today = datetime.now(discovery.CHINA).date()
        date = today.isoformat()
        old = (today - timedelta(days=31)).isoformat()
        link = "https://example.org/current.html"
        fixtures = [
            discovery.candidate("音视频软件采购公告", link, "测试", channel="搜索索引"),
            discovery.candidate("音视频软件采购公告", link, "测试", published_at=date),
            discovery.candidate("过期软件采购公告", "https://example.org/old.html", "测试", published_at=old),
            discovery.candidate("未标日期软件采购公告", "https://example.org/undated.html", "测试"),
        ]
        with patch.object(discovery, "LISTS", (("Fixture", "https://example.org/list"),)), \
             patch.object(discovery, "fetch_source", return_value=(fixtures, None)) as fetch, \
             patch.dict(os.environ, {"BIDS_DISCOVERY_SOURCES": "Fixture", "BIDS_DISCOVERY_DAYS": "30"}):
            result = discovery.discover("软件")
        self.assertEqual(fetch.call_count, 1)
        self.assertEqual(result["source_count"], 1)
        self.assertEqual(len(result["candidates"]), 2)
        self.assertEqual(result["candidates"][0]["published_at"], date)
        self.assertEqual(result["candidates"][1]["published_at"], "")
        self.assertEqual(result["errors"], [])

    def test_discovery_retains_access_failure_as_error(self):
        error = {"source": "Fixture", "message": "原站返回HTTP 403，请打开原站查询"}
        with patch.object(discovery, "LISTS", (("Fixture", "https://example.org/list"),)), \
             patch.object(discovery, "fetch_source", return_value=([], error)), \
             patch.dict(os.environ, {"BIDS_DISCOVERY_SOURCES": "Fixture"}):
            result = discovery.discover("软件")
        self.assertEqual(result["candidates"], [])
        self.assertEqual(result["errors"], [error])
        self.assertEqual(result["source_count"], 1)


if __name__ == "__main__":
    unittest.main()
