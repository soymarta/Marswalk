#!/usr/bin/env python3
"""agentchat: team-to-team messaging over GitHub issues, with change detection.

  agentchat.py watch --team NAME     poll GitHub, print one line per message addressed to NAME
  agentchat.py inbox --team NAME [--poll]   print unread messages (for agents without a push channel)
  agentchat.py send  --team NAME --to OTHER --type TYPE (--issue N | --title T) "text"

Needs only `gh` (authenticated) and Python 3 stdlib. Messages are issue comments whose
first lines are a header:

    to: route            (team names, comma separated, or "all")
    from: terrain
    type: request        (request | answer | handoff | blocker | fyi | decision)

Polling uses ETags, so an unchanged repo returns 304 and does not count against the
GitHub rate limit.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

TYPES = ("request", "answer", "handoff", "blocker", "fyi", "decision")
STATE_DIR = Path(os.environ.get("AGENTCHAT_STATE", ".agentchat"))
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def gh(*args, check=True):
    p = subprocess.run(["gh", *args], capture_output=True, text=True, encoding="utf-8", errors="replace")
    if check and p.returncode != 0:
        sys.exit(f"gh {' '.join(args[:3])}… failed: {p.stderr.strip() or p.stdout.strip()}")
    return p


def default_repo():
    return gh("repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner").stdout.strip()


def header(body):
    """Parse the to/from/type header out of the first lines of a message."""
    h = {}
    for line in (body or "").strip().splitlines()[:6]:
        m = re.match(r"^\W*(to|from|type)\s*:\s*(.+?)\W*$", line.strip(), re.I)
        if m:
            h[m.group(1).lower()] = m.group(2).strip()
    return h


def addressed_to(team, body, labels=(), login=None):
    h = header(body)
    targets = [t.strip().lower() for t in re.split(r"[,\s]+", h.get("to", "")) if t.strip()]
    aliases = [team.lower()]
    if team.lower() in ("hamza", "hamza-go"):
        aliases = ["hamza", "hamza-go"]
    if team.lower() in ("route", "hani", "hani-go"):
        aliases = ["route", "hani", "hani-go"]
    if any(a in targets for a in aliases) or "all" in targets:
        return True
    if any(re.search(rf"@team-{re.escape(a)}\b", body or "", re.I) for a in aliases):
        return True
    if login and re.search(rf"(?<![\w/])@{re.escape(login)}\b", body or "", re.I):
        return True  # a GitHub @mention of the human running this agent
    return any(f"team:{a}".lower() in [l.lower() for l in labels] for a in aliases)


# ----------------------------------------------------------------------------- watch
def api_get(path, etag):
    """GET via gh with a conditional request. Returns (status, etag, json)."""
    args = ["api", "-i", path]
    if etag:
        args += ["-H", f"If-None-Match: {etag}"]
    p = gh(*args, check=False)
    out = p.stdout
    status = int(re.match(r"HTTP/\S+ (\d+)", out).group(1)) if out.startswith("HTTP") else 0
    if status == 304:
        return 304, etag, None
    if status != 200:
        raise RuntimeError(f"{path}: HTTP {status or '?'} {p.stderr.strip()[:200]}")
    head, _, body = out.partition("\r\n\r\n") if "\r\n\r\n" in out else out.partition("\n\n")
    m = re.search(r"^etag:\s*(.+)$", head, re.I | re.M)
    return 200, (m.group(1).strip() if m else None), json.loads(body)


def load_state(path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_state(path, state):
    path.parent.mkdir(parents=True, exist_ok=True)
    state["seen"] = state["seen"][-1000:]
    path.write_text(json.dumps(state), encoding="utf-8")


def emit(team, kind, number, h, body, url, user, quiet=False):
    frm = h.get("from") or f"@{user}"
    typ = h.get("type", "message")
    text = " ".join((body or "").split())
    text = re.sub(r"^(?:\W*(?:to|from|type)\s*:\s*\S+\W*\s*)+", "", text, flags=re.I)
    line = f"[#{number} {frm} → {team} | {typ}] {text[:400]} {url}"
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    with open(STATE_DIR / f"{team}.inbox", "a", encoding="utf-8") as f:  # inbox for agents with no push channel
        f.write(line + "\n")
    if not quiet:
        print(line, flush=True)


def watch(a):
    repo = a.repo or default_repo()
    state_path = STATE_DIR / f"{a.team}.json"
    state = load_state(state_path)
    first_run = not state
    if first_run:
        state = {"since": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "seen": []}
        if a.since:
            state["since"] = a.since
    etags = {}
    login = gh("api", "user", "-q", ".login", check=False).stdout.strip() or None
    quiet = getattr(a, "quiet", False)
    if not quiet:
        print(f"agentchat: team '{a.team}' watching {repo} every {a.interval}s "
              f"(since {state['since']})", flush=True)

    while True:
        poll_start = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        try:
            events = []  # (created_at, kind, number, header, body, url, user)
            st, etags["c"], comments = api_get(
                f"repos/{repo}/issues/comments?since={state['since']}&per_page=100", etags.get("c"))
            for c in comments or []:
                key = f"c{c['id']}"
                if key in state["seen"]:
                    continue
                state["seen"].append(key)
                num = c["issue_url"].rsplit("/", 1)[-1]
                events.append((c["created_at"], "comment", num, c["body"], c["html_url"],
                               c["user"]["login"], []))
            st, etags["i"], issues = api_get(
                f"repos/{repo}/issues?state=open&since={state['since']}&per_page=100", etags.get("i"))
            for i in issues or []:
                key = f"i{i['id']}"
                if key in state["seen"] or "pull_request" in i:
                    continue
                state["seen"].append(key)
                body = f"{i['title']}\n{i.get('body') or ''}"
                events.append((i["created_at"], "issue", str(i["number"]), i.get("body") or "",
                               i["html_url"], i["user"]["login"], [l["name"] for l in i["labels"]]))
            for created, kind, num, body, url, user, labels in sorted(events):
                h = header(body)
                if h.get("from", "").lower() == a.team.lower():
                    continue  # our own message
                if not addressed_to(a.team, body, labels, login):
                    continue
                if first_run and not a.since and created < state["since"]:
                    continue
                emit(a.team, kind, num, h, body, url, user, quiet)
            state["since"] = poll_start
            save_state(state_path, state)
        except Exception as e:  # network blips must not kill the watcher
            print(f"agentchat: poll error: {e}", file=sys.stderr, flush=True)
        first_run = False
        if a.once:
            return
        time.sleep(a.interval)


def inbox(a):
    """Print messages not yet read. With --poll, check GitHub once first (no background watcher needed)."""
    if a.poll:
        a.once, a.quiet, a.since, a.interval = True, True, None, 15
        watch(a)
    log, mark = STATE_DIR / f"{a.team}.inbox", STATE_DIR / f"{a.team}.read"
    lines = log.read_text(encoding="utf-8").splitlines() if log.exists() else []
    done = int(mark.read_text(encoding="utf-8")) if mark.exists() else 0
    for line in lines[done:]:
        print(line)
    if len(lines) == done:
        print("agentchat: no new messages")
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    mark.write_text(str(len(lines)), encoding="utf-8")


# ----------------------------------------------------------------------------- send
def send(a):
    repo = a.repo or default_repo()
    if a.type not in TYPES:
        sys.exit(f"--type must be one of {', '.join(TYPES)}")
    text = a.text if a.text != "-" else sys.stdin.read()
    body = f"to: {a.to}\nfrom: {a.team}\ntype: {a.type}\n\n{text.strip()}\n"
    if a.mention:  # real @mentions: GitHub also notifies those people
        body += "\ncc " + " ".join("@" + m.strip().lstrip("@") for m in a.mention.split(",")) + "\n"
    if a.issue:
        out = gh("issue", "comment", str(a.issue), "-R", repo, "--body", body).stdout.strip()
    else:
        if not a.title:
            sys.exit("need --issue N (reply in a thread) or --title T (open a new thread)")
        out = gh("issue", "create", "-R", repo, "--title", a.title, "--body", body).stdout.strip()
    print(out)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    for name in ("watch", "send", "inbox"):
        s = sub.add_parser(name)
        s.add_argument("--team", default=os.environ.get("TEAM"), required=not os.environ.get("TEAM"))
        s.add_argument("--repo", default=os.environ.get("AGENTCHAT_REPO"))
        if name == "watch":
            s.add_argument("--interval", type=int, default=int(os.environ.get("AGENTCHAT_INTERVAL", 15)))
            s.add_argument("--since", help="ISO time to replay from on first run (default: now)")
            s.add_argument("--once", action="store_true", help="poll once and exit")
            s.set_defaults(fn=watch)
        elif name == "inbox":
            s.add_argument("--poll", action="store_true", help="check GitHub once before reading")
            s.set_defaults(fn=inbox)
        else:
            s.add_argument("--to", required=True, help="team name(s), comma separated, or 'all'")
            s.add_argument("--type", required=True)
            s.add_argument("--mention", help="GitHub handle(s), comma separated, to @mention (notifies them)")
            s.add_argument("--issue", type=int)
            s.add_argument("--title")
            s.add_argument("text", help="message body, or '-' to read stdin")
            s.set_defaults(fn=send)
    a = p.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
