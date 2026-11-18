#!/usr/bin/env python3
"""
Bilibili Subtitle & Metadata Reader (scripts/bili_sub.py)
Supports:
  1. `bili_sub.py login`: Generate QR code PNG and poll for 180s to save cookies automatically.
  2. `bili_sub.py status`: Check whether saved cookies are valid.
  3. `bili_sub.py <BV_or_URL> [--p 1] [--no-comments]`: Extract video metadata, CC/AI subtitles, and top comments.
"""

import argparse
import functools
import hashlib
import json
import os
import re
import sys
import time
import urllib.parse
import xml.etree.ElementTree as ET
from pathlib import Path

import qrcode
import requests

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_COOKIE_PATH = PROJECT_ROOT / "data" / "bili_cookies.json"
COOKIE_FILE = Path(os.environ.get("BILI_COOKIE_FILE") or DEFAULT_COOKIE_PATH)
QR_IMG_PATH = PROJECT_ROOT / "data" / "bili_login_qr.png"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Referer": "https://www.bilibili.com/",
}

MIXIN_KEY_ENC_TAB = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
    33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
    61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
    36, 20, 34, 44, 52
]


def get_mixin_key(orig: str) -> str:
    return functools.reduce(lambda s, i: s + orig[i], MIXIN_KEY_ENC_TAB, "")[:32]


def enc_wbi(params: dict, img_key: str, sub_key: str) -> dict:
    mixin_key = get_mixin_key(img_key + sub_key)
    curr_time = round(time.time())
    params = dict(params)
    params["wts"] = curr_time
    params = dict(sorted(params.items()))
    params = {
        k: "".join(filter(lambda chr_: chr_ not in "!'()*", str(v)))
        for k, v in params.items()
    }
    query = urllib.parse.urlencode(params)
    wbi_sign = hashlib.md5((query + mixin_key).encode()).hexdigest()
    params["w_rid"] = wbi_sign
    return params


def resolve_cookie_file() -> Path:
    if COOKIE_FILE.exists():
        return COOKIE_FILE
    fallback = Path.home() / ".config" / "bili_cookies.json"
    if fallback.exists():
        return fallback
    return COOKIE_FILE


def build_session() -> requests.Session:
    s = requests.Session()
    s.headers.update(HEADERS)
    cf = resolve_cookie_file()
    if cf.exists():
        try:
            data = json.loads(cf.read_text(encoding="utf-8"))
            cookies = data.get("cookies", {})
            for k, v in cookies.items():
                s.cookies.set(k, v, domain=".bilibili.com")
        except Exception as e:
            print(f"[WARN] Failed to load {cf}: {e}", file=sys.stderr)
    if "buvid3" not in s.cookies:
        try:
            r = s.get("https://api.bilibili.com/x/frontend/finger/spi", timeout=8)
            j = r.json()
            if j.get("code") == 0:
                s.cookies.set("buvid3", j["data"]["b_3"], domain=".bilibili.com")
                s.cookies.set("buvid4", j["data"]["b_4"], domain=".bilibili.com")
        except Exception:
            pass
    return s


def get_wbi_keys(s: requests.Session) -> tuple[str, str]:
    resp = s.get("https://api.bilibili.com/x/web-interface/nav", timeout=10)
    json_content = resp.json()
    wbi_img = json_content.get("data", {}).get("wbi_img", {})
    img_url = wbi_img.get("img_url", "")
    sub_url = wbi_img.get("sub_url", "")
    img_key = img_url.rsplit("/", 1)[1].split(".")[0]
    sub_key = sub_url.rsplit("/", 1)[1].split(".")[0]
    return img_key, sub_key


def do_login_qr(poll_seconds: int = 180):
    s = requests.Session()
    s.headers.update(HEADERS)
    r = s.get(
        "https://passport.bilibili.com/x/passport-login/web/qrcode/generate",
        timeout=10,
    )
    j = r.json()
    if j.get("code") != 0:
        print(f"[ERROR] QR generate failed: {j}")
        sys.exit(1)

    qr_url = j["data"]["url"]
    qr_key = j["data"]["qrcode_key"]

    QR_IMG_PATH.parent.mkdir(parents=True, exist_ok=True)
    qr = qrcode.QRCode(box_size=8, border=3)
    qr.add_data(qr_url)
    qr.make(fit=True)
    img = qr.make_image(fill_color="black", back_color="white")
    img.save(QR_IMG_PATH)

    print(f"QR_IMAGE_PATH={QR_IMG_PATH}")
    print(f"QR_KEY={qr_key}")
    sys.stdout.flush()

    if poll_seconds <= 0:
        return

    deadline = time.time() + poll_seconds
    while time.time() < deadline:
        time.sleep(2.5)
        try:
            pr = s.get(
                "https://passport.bilibili.com/x/passport-login/web/qrcode/poll",
                params={"qrcode_key": qr_key},
                timeout=10,
            )
            pj = pr.json()
            data = pj.get("data", {})
            code = data.get("code")
            if code == 0:
                cookies_dict = requests.utils.dict_from_cookiejar(s.cookies)
                url_str = data.get("url", "")
                if "?" in url_str:
                    qs = urllib.parse.parse_qs(url_str.split("?", 1)[1])
                    for k, v in qs.items():
                        if v and k in ("SESSDATA", "bili_jct", "DedeUserID", "DedeUserID__ckMd5", "sid"):
                            cookies_dict[k] = v[0]
                save_payload = {
                    "updated_at": int(time.time()),
                    "refresh_token": data.get("refresh_token", ""),
                    "cookies": cookies_dict,
                }
                COOKIE_FILE.parent.mkdir(parents=True, exist_ok=True)
                COOKIE_FILE.write_text(
                    json.dumps(save_payload, indent=2, ensure_ascii=False),
                    encoding="utf-8",
                )
                os.chmod(COOKIE_FILE, 0o600)
                print("[SUCCESS] Login confirmed and cookies saved to", COOKIE_FILE)
                return
            elif code == 86038:
                print("[EXPIRED] QR code expired.")
                return
        except Exception as e:
            print(f"[WARN] Poll error: {e}", file=sys.stderr)
    print("[TIMEOUT] QR poll timed out.")


def check_status():
    s = build_session()
    r = s.get("https://api.bilibili.com/x/web-interface/nav", timeout=10)
    j = r.json()
    data = j.get("data", {})
    if data.get("isLogin"):
        print(f"[LOGGED_IN] uname={data.get('uname')} mid={data.get('mid')} vip={data.get('vipStatus')}")
    else:
        print("[NOT_LOGGED_IN] Valid SESSDATA cookie not found or expired.")


def extract_bvid_or_aid(target: str, s: requests.Session) -> dict:
    target = target.strip()
    if "b23.tv" in target:
        r = s.get(target, allow_redirects=True, timeout=10)
        target = r.url
    m_bv = re.search(r"(BV[0-9A-Za-z]{10})", target)
    if m_bv:
        return {"bvid": m_bv.group(1)}
    m_av = re.search(r"av(\d+)", target, re.I)
    if m_av:
        return {"aid": int(m_av.group(1))}
    raise ValueError(f"Could not extract BV or av ID from: {target}")


def fmt_ts(seconds: float) -> str:
    m, sec = divmod(int(seconds), 60)
    h, m = divmod(m, 60)
    if h > 0:
        return f"{h:02d}:{m:02d}:{sec:02d}"
    return f"{m:02d}:{sec:02d}"


def read_video(target: str, page_num: int = 1, include_comments: bool = True):
    s = build_session()
    id_params = extract_bvid_or_aid(target, s)
    r = s.get("https://api.bilibili.com/x/web-interface/view", params=id_params, timeout=10)
    j = r.json()
    if j.get("code") != 0:
        print(f"[ERROR] Failed to fetch video info: {j}")
        sys.exit(1)

    vdata = j["data"]
    aid = vdata["aid"]
    bvid = vdata["bvid"]
    title = vdata["title"]
    desc = vdata.get("desc", "")
    owner = vdata.get("owner", {}).get("name", "")
    stat = vdata.get("stat", {})
    pages = vdata.get("pages", [])

    idx = max(0, min(page_num - 1, len(pages) - 1))
    page_info = pages[idx]
    cid = page_info["cid"]
    part_title = page_info.get("part", "")
    duration = page_info.get("duration", vdata.get("duration", 0))

    print("=" * 68)
    print(f"标题: {title}")
    print(f"UP主: {owner} | BV号: {bvid} (aid={aid}, cid={cid})")
    print(f"分P : P{idx+1}/{len(pages)} - {part_title} (时长: {fmt_ts(duration)})")
    print(f"数据: 播放 {stat.get('view')} | 点赞 {stat.get('like')} | 投币 {stat.get('coin')} | 收藏 {stat.get('favorite')}")
    if desc:
        print(f"简介:\n{desc}")
    print("=" * 68)

    img_key, sub_key = get_wbi_keys(s)
    wbi_params = enc_wbi({"aid": aid, "cid": cid}, img_key, sub_key)
    pr = s.get("https://api.bilibili.com/x/player/wbi/v2", params=wbi_params, timeout=10)
    pj = pr.json()
    pdata = pj.get("data", {})
    need_login = pdata.get("need_login_subtitle", False)
    sub_list = pdata.get("subtitle", {}).get("subtitles", [])

    if sub_list:
        chosen = sub_list[0]
        lan = chosen.get("lan_doc", chosen.get("lan", ""))
        sub_url = chosen.get("subtitle_url", "")
        if sub_url.startswith("//"):
            sub_url = "https:" + sub_url
        print(f"\n[字幕列表] 共找到 {len(sub_list)} 轨字幕，正在读取: {lan}")
        sr = s.get(sub_url, timeout=10)
        sj = sr.json()
        body = sj.get("body", [])
        print(f"[逐字稿] 共 {len(body)} 句:\n")
        for item in body:
            t_from = fmt_ts(item.get("from", 0))
            content = item.get("content", "").strip()
            print(f"[{t_from}] {content}")
    else:
        print("\n[字幕状态] 未返回字幕轨道。")
        if need_login:
            print("  原因: B站接口提示 `need_login_subtitle=True`（该视频有AI/CC字幕，但需登录Cookie后才下发）。")
        else:
            print("  原因: 该视频可能无CC/AI字幕，或当前未登录。")

        try:
            dr = s.get(f"https://comment.bilibili.com/{cid}.xml", timeout=10)
            dr.encoding = "utf-8"
            root = ET.fromstring(dr.text)
            dms = []
            for d in root.findall("d"):
                p_attr = d.attrib.get("p", "").split(",")
                sec = float(p_attr[0]) if p_attr and p_attr[0] else 0.0
                dms.append((sec, (d.text or "").strip()))
            dms.sort(key=lambda x: x[0])
            print(f"\n[弹幕时间轴兜底] 共抓到 {len(dms)} 条弹幕（节选前 60 条）:")
            step = max(1, len(dms) // 60)
            for sec, txt in dms[::step][:60]:
                print(f"  [{fmt_ts(sec)}] {txt}")
        except Exception as e:
            print(f"[WARN] 弹幕拉取失败: {e}")

    if include_comments:
        try:
            cr = s.get(
                "https://api.bilibili.com/x/v2/reply/main",
                params={"type": 1, "oid": aid, "mode": 3},
                timeout=10,
            )
            cj = cr.json()
            replies = cj.get("data", {}).get("replies") or []
            top_replies = cj.get("data", {}).get("top_replies") or []
            all_reps = top_replies + replies[:8]
            if all_reps:
                print("\n" + "=" * 68)
                print(f"[高赞/置顶评论] (前 {len(all_reps)} 条):")
                for idx_r, rep in enumerate(all_reps, 1):
                    uname = rep.get("member", {}).get("uname", "")
                    likes = rep.get("like", 0)
                    msg = rep.get("content", {}).get("message", "").strip()
                    print(f"\n--- #{idx_r} @{uname} (👍 {likes}) ---")
                    print(msg)
        except Exception as e:
            print(f"[WARN] 评论区拉取失败: {e}")


def main():
    parser = argparse.ArgumentParser(description="Bilibili Subtitle & Metadata Reader")
    parser.add_argument("action_or_target", help="'login', 'status', or BV/URL")
    parser.add_argument("--p", type=int, default=1, help="Page number (1-indexed)")
    parser.add_argument("--poll", type=int, default=180, help="Seconds to poll QR login")
    parser.add_argument("--no-comments", action="store_true", help="Skip comments")
    args = parser.parse_args()

    if args.action_or_target == "login":
        do_login_qr(poll_seconds=args.poll)
    elif args.action_or_target == "status":
        check_status()
    else:
        read_video(args.action_or_target, page_num=args.p, include_comments=not args.no_comments)


if __name__ == "__main__":
    main()
