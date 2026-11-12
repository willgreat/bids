"""Read public procurement lists and search feeds for reviewable leads.

No result is treated as a verified project or an invitation to bid.  Only fixed
public endpoints are fetched.  A result's publication date comes from its
procurement list row, never from a search engine's indexing timestamp.
"""

from concurrent.futures import ThreadPoolExecutor, wait
from datetime import datetime, timedelta, timezone
from html import unescape
from html.parser import HTMLParser
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urljoin, urlsplit, urlunsplit
from urllib.request import Request, urlopen
from xml.etree import ElementTree
import os
import re
import socket


CHINA = timezone(timedelta(hours=8))
DEFAULT_QUERY = "软件开发 音视频 RTC 智能客服 系统运维"
SOFTWARE_TERMS = (
    "软件", "开发", "门户", "小程序", "公众号", "音视频", "语音",
    "视频会议", "云课堂", "客服", "数字人", "智能体", "人工智能", "运维", "RTC",
)
TECHNICAL_CONTEXT = ("软件", "系统", "平台", "数据", "信息", "应用", "算法", "程序", "门户", "小程序", "公众号", "音视频", "语音", "视频会议", "云课堂", "客服", "数字人", "智能体", "人工智能", "RTC")
PROCUREMENT_TERMS = ("采购", "招标", "询比", "竞价", "比选", "磋商", "谈判", "征集", "快速交易", "更正", "澄清", "补充")
FINISHED_TERMS = ("中标", "成交", "结果公告", "废标", "终止", "流标")
LISTS = (
    ("中国政府采购网·中央公开招标", "https://www.ccgp.gov.cn/cggg/zygg/gkzb/"),
    ("中国政府采购网·地方公开招标", "https://www.ccgp.gov.cn/cggg/dfgg/gkzb/"),
    ("中国政府采购网·中央竞争性磋商", "https://www.ccgp.gov.cn/cggg/zygg/jzxcs/"),
    ("中国政府采购网·地方竞争性磋商", "https://www.ccgp.gov.cn/cggg/dfgg/jzxcs/"),
    ("杭州电子科技大学采购中心", "https://cgzx.hdu.edu.cn/"),
    ("复旦大学采购与招标管理中心", "https://cz.fudan.edu.cn/fudanstatic/cgxxfw/index.html"),
    ("太原理工大学采购信息网", "https://cgzb.tyut.edu.cn/xxgk/zfcg/cggg.htm"),
    ("银联国际采购公告", "https://www.unionpayintl.com/cn/mediaCenter/newsCenter/PurchaseAnnouncement/"),
)
DATE_PATTERN = re.compile(r"(20\d{2})[-/年.](\d{1,2})[-/月.](\d{1,2})(?:日)?")
HEADERS = {"User-Agent": "YiyouyinliBids/1.0 (+https://www.yiyouyinli.com)", "Accept": "text/html,application/rss+xml,application/xml;q=0.9"}


class Node:
    def __init__(self, tag="", attrs=None, parent=None):
        self.tag = tag
        self.attrs = dict(attrs or [])
        self.parent = parent
        self.children = []

    def text(self):
        return " ".join(c.text() if isinstance(c, Node) else c for c in self.children)


class PublicListParser(HTMLParser):
    VOID_TAGS = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = Node()
        self.current = self.root
        self.anchors = []

    def handle_starttag(self, tag, attrs):
        node = Node(tag, attrs, self.current)
        self.current.children.append(node)
        if tag == "a":
            self.anchors.append(node)
        if tag not in self.VOID_TAGS:
            self.current = node

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in self.VOID_TAGS:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        node = self.current
        while node.parent is not None:
            if node.tag == tag:
                self.current = node.parent
                return
            node = node.parent

    def handle_data(self, data):
        if self.current.tag not in {"script", "style"}:
            self.current.children.append(data)


def clean(text):
    text = re.sub(r"<[^>]+>", " ", text or "")
    return re.sub(r"\s+", " ", unescape(text)).strip()


def public_url(raw, base):
    url = urljoin(base, (raw or "").strip())
    parts = urlsplit(url)
    if parts.scheme not in {"http", "https"} or not parts.hostname or parts.username or parts.password:
        return None
    # We display links, but never fetch candidate URLs.  Reject local/private
    # literal addresses nonetheless, so imports cannot become local shortcuts.
    host = parts.hostname.lower()
    if host in {"localhost", "0.0.0.0", "::1"} or re.match(r"^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)", host):
        return None
    return urlunsplit((parts.scheme, parts.netloc, parts.path, parts.query, ""))


def date_in(text):
    match = DATE_PATTERN.search(text)
    if not match:
        return ""
    try:
        return datetime(*(int(value) for value in match.groups()), tzinfo=CHINA).date().isoformat()
    except ValueError:
        return ""


def query_terms(query):
    words = [part for part in re.split(r"[\s,，;；|/]+", query) if len(part) >= 2]
    for term in SOFTWARE_TERMS:
        if term.lower() in query.lower() and term not in words:
            words.append(term)
    return words


def relevant(title, terms):
    text = title.lower()
    return (
        any(term in title for term in PROCUREMENT_TERMS)
        and not any(term in title for term in FINISHED_TERMS)
        and any(term.lower() in text for term in SOFTWARE_TERMS)
        and any(term.lower() in text for term in TECHNICAL_CONTEXT)
        and not any(term in title for term in ("设备及软件", "软硬件采购", "软件及硬件", "服务器采购"))
        and any(term.lower() in text for term in terms)
    )


def platform_for(url, fallback):
    host = urlsplit(url).hostname or ""
    if host.endswith("ccgp.gov.cn"):
        return "中国政府采购网"
    if host.endswith("chinatelecom.com.cn"):
        return "中国电信阳光采购网"
    if host.endswith("unionpayintl.com"):
        return "银联国际"
    return fallback


def candidate(title, url, platform, summary="", published_at="", channel="公开采购公告列表"):
    return {
        "title": title[:180],
        "source_url": url,
        "platform": platform_for(url, platform),
        "summary": clean(summary)[:600],
        "published_at": published_at,
        "discovery_status": "待核实",
        "discovery_channel": channel,
        "notice_type": "更正/补充" if any(s in title for s in ("更正", "澄清", "补充")) else "采购线索",
    }


def descendants(node):
    pending = [node]
    while pending:
        current = pending.pop()
        yield current
        pending.extend(child for child in reversed(current.children) if isinstance(child, Node))


def list_title(anchor, terms):
    nodes = list(descendants(anchor))
    explicit = [clean(node.attrs["title"]) for node in nodes if node.attrs.get("title")]
    headings = [clean(node.text()) for node in nodes if node.tag in {"h1", "h2", "h3", "h4", "h5", "h6"}]
    named = [clean(node.text()) for node in nodes if re.search(r"title|headline|news[_-]?name|btt|news[_-]?tit", node.attrs.get("class", ""), re.I)]
    leaves = [clean(node.text()) for node in nodes if not any(isinstance(child, Node) for child in node.children)]
    text = clean(anchor.text())
    for group in (explicit, headings, named, leaves):
        matches = [value for value in group if len(value) >= 8 and relevant(value, terms)]
        if matches:
            text = min(matches, key=len)
            break
    text = re.sub(r"^20\d{2}[-/年.]\d{1,2}[-/月.]\d{1,2}日?\s*", "", text)
    ending = re.search(r"(?:竞争性磋商|竞争性谈判|公开招标|询比|竞价|采购|招标|比选|快速交易|更正|补充|澄清)公告(?:[（(][^）)]{1,20}[）)])?", text)
    if ending:
        text = text[:ending.end()]
    return text[:180]


def list_publication_date(anchor):
    for node in descendants(anchor):
        if node.tag == "time" or re.search(r"(?:date|time)", node.attrs.get("class", ""), re.I):
            value = date_in(node.attrs.get("datetime", "") or node.text())
            if value:
                return value
    own_text = clean(anchor.text())
    if DATE_PATTERN.match(own_text):
        return date_in(own_text)
    node = anchor
    for _ in range(4):
        node = node.parent
        if node is None:
            break
        # A shared news container can include several projects and dates.  Only
        # use an enclosing row when this anchor is its single article link.
        links = [child for child in descendants(node) if child.tag == "a" and child.attrs.get("href")]
        if len(links) != 1:
            break
        text = clean(node.text())
        if len(text) > 1000:
            break
        value = date_in(text)
        if value:
            return value
        if node.tag in {"li", "tr"}:
            break
    return ""


def parse_list(content, base, name, terms):
    parser = PublicListParser()
    parser.feed(content)
    results = []
    for anchor in parser.anchors:
        title = list_title(anchor, terms)
        if len(title) < 8 or not relevant(title, terms):
            continue
        url = public_url(anchor.attrs.get("href"), base)
        if not url or not urlsplit(url).path or urlsplit(url).path.endswith("/"):
            continue
        results.append(candidate(title, url, name, anchor.text(), list_publication_date(anchor)))
    return results


def parse_feed(content, base, terms):
    root = ElementTree.fromstring(content)
    results = []
    for item in root.findall(".//item"):
        title = clean(item.findtext("title"))
        url = public_url(item.findtext("link"), base)
        if not url or not relevant(title, terms):
            continue
        host = urlsplit(url).hostname or ""
        official = host.endswith((".gov.cn", ".edu.cn", "chinatelecom.com.cn", "unionpayintl.com", "chinatawercom.cn", "chinatowercom.cn", "chinamobile.com"))
        results.append(candidate(title, url, "官网线索" if official else "搜索引擎线索（转载需核对原公告）", item.findtext("description"), channel="Bing公开搜索RSS"))
    return results


def fetch_source(name, url, kind, terms):
    try:
        with urlopen(Request(url, headers=HEADERS), timeout=6) as response:
            data = response.read(1500001)
            if len(data) > 1500000:
                return [], {"source": name, "message": "公告页超过本次读取上限，请打开原站查询"}
            declared = response.headers.get_content_charset()
        encoding_match = re.search(br"charset\s*=\s*[\"']?([a-zA-Z0-9_-]+)", data[:5000])
        encoding = declared or (encoding_match.group(1).decode("ascii") if encoding_match else "utf-8")
        text = data.decode(encoding, errors="replace")
        if any(token in text[:2000].lower() for token in ("captcha", "verify you are human", "access denied", "人机验证", "访问过于频繁")):
            return [], {"source": name, "message": "原站要求验证，请通过原站人工查询"}
        items = parse_feed(text, url, terms) if kind == "rss" else parse_list(text, url, name, terms)
        return items, None
    except HTTPError as exc:
        return [], {"source": name, "message": "原站返回HTTP %s，请打开原站查询" % exc.code}
    except (URLError, TimeoutError, socket.timeout, OSError):
        return [], {"source": name, "message": "本次网络访问失败或超时，请稍后重试"}
    except (ElementTree.ParseError, LookupError, ValueError):
        return [], {"source": name, "message": "原站内容格式变更，本次未能解析"}


def manual_search_links(query):
    return [
        {"label": "中国电信阳光采购网", "url": "https://caigou.chinatelecom.com.cn/"},
        {"label": "中国政府采购网", "url": "https://www.ccgp.gov.cn/"},
        {"label": "银联国际采购公告", "url": LISTS[-1][1]},
        {"label": "Bing检索采购公告", "url": "https://www.bing.com/search?" + urlencode({"q": query + " 采购 招标"})},
    ]


def discover(query):
    """Return current public leads without deciding eligibility or participation."""
    if not isinstance(query, str):
        raise ValueError("请输入检索关键词")
    query = clean(query).strip() or DEFAULT_QUERY
    if len(query) > 200:
        raise ValueError("检索关键词最多200字")
    terms = query_terms(query)
    sources = [(name, url, "html") for name, url in LISTS]
    for name, suffix in (("政府采购搜索", "site:ccgp.gov.cn"), ("电信采购搜索", "site:caigou.chinatelecom.com.cn"), ("银联采购搜索", "site:unionpayintl.com")):
        url = "https://www.bing.com/search?" + urlencode({"format": "rss", "q": suffix + " " + query + " 采购"})
        sources.append((name, url, "rss"))
    results, errors = [], []
    selection = os.environ.get("BIDS_DISCOVERY_SOURCES", "").strip()
    if selection:
        requested = [name.strip() for name in selection.split(",") if name.strip()]
        sources = [source for source in sources if any(name in source[0] or name == urlsplit(source[1]).hostname for name in requested)]
    pool = ThreadPoolExecutor(max_workers=max(1, len(sources)))
    futures = {pool.submit(fetch_source, name, url, kind, terms): name for name, url, kind in sources}
    try:
        completed, pending = wait(futures, timeout=22)
        for future in completed:
            try:
                items, error = future.result()
            except Exception:
                errors.append({"source": futures[future], "message": "本次来源解析失败，请打开原站核实"})
                continue
            results.extend(items)
            if error:
                errors.append(error)
        for future in pending:
            future.cancel()
            errors.append({"source": futures[future], "message": "本次检索已到时间上限，请打开原站查询"})
    finally:
        pool.shutdown(wait=False, cancel_futures=True)
    try:
        max_age = max(1, min(365, int(os.environ.get("BIDS_DISCOVERY_DAYS", "30"))))
    except ValueError:
        max_age = 30
    threshold = (datetime.now(CHINA) - timedelta(days=max_age)).date().isoformat()
    unique = {}
    # Prefer dated primary-source list results over duplicate search snippets.
    for item in sorted(results, key=lambda item: bool(item["published_at"]), reverse=True):
        date = item["published_at"]
        if date and date < threshold:
            continue
        key = item["source_url"]
        title_key = re.sub(r"[\s·｜|【】\[\]]", "", item["title"]).lower()
        if key not in unique and not any(existing["_title_key"] == title_key for existing in unique.values()):
            unique[key] = dict(item, _title_key=title_key)
    ordered = sorted(unique.values(), key=lambda item: item["published_at"], reverse=True)[:25]
    for item in ordered:
        item.pop("_title_key")
    return {
        "candidates": ordered,
        "errors": errors,
        "search_links": manual_search_links(query),
        "checked_at": datetime.now(CHINA).isoformat(timespec="seconds"),
        "query": query,
        "source_count": len(sources),
        "notice": "候选来自公开列表和搜索索引。金额、资格、截止时间及更正须打开原公告核实。中国电信等平台登录后的公告和完整采购文件请在原站领取。",
    }


if __name__ == "__main__":
    import json
    import sys
    print(json.dumps(discover(" ".join(sys.argv[1:]) or DEFAULT_QUERY), ensure_ascii=False, indent=2))
