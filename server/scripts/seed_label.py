#!/usr/bin/env python3
"""Seed the Gmail label read by Brief (BRIEF-D3 § 3.7). Python 3.11, standard library only. The CEO runs it.

  python3 scripts/seed_label.py --dry-run            no network: prints the messages, USER and DOMAIN in place of the account
  python3 scripts/seed_label.py                      appends the 4 persona mails to the label (created when absent)
  python3 scripts/seed_label.py --only lina          appends one (« a new mail arrives »)
  python3 scripts/seed_label.py --label brief-demo   the label (default brief-demo)

Credentials ONLY from the environment: BRIEF_IMAP_USER (the account) and BRIEF_IMAP_APP_PASSWORD (an app password).
Host imap.gmail.com, port 993, TLS verified. It never prints the address or the password, never sends a mail (IMAP
APPEND only: the messages are placed in the label, nothing goes through SMTP), never selects or writes another folder.
Exit 0 or 1, with one plain line.
"""
from __future__ import annotations

import argparse
import datetime as dt
import imaplib
import json
import os
import re
import ssl
import sys
from email.headerregistry import Address
from email.message import EmailMessage
from email.policy import SMTP
from email.utils import format_datetime, make_msgid
from pathlib import Path
from zoneinfo import ZoneInfo

HOST = "imap.gmail.com"
PORT = 993
DEFAULT_LABEL = "brief-demo"
MSGID_DOMAIN = "brief-demo.invalid"
DISPLAY_TZ = "America/Toronto"
DATASET = Path(__file__).resolve().parent.parent.parent / "src" / "data" / "dataset.json"
# A label we create and write: plain characters only, never a system folder.
LABEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
SYSTEM = {"inbox", "sent", "drafts", "spam", "trash", "outbox"}
TIME_RE = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")


class Refused(Exception):
    """A plain reason to stop; its text never holds the address or the password."""


def load_records(path: Path = DATASET) -> list[dict]:
    """The dataset's mail records whose persona has an email, in dataset order, with the persona's key and name."""
    ds = json.loads(path.read_text(encoding="utf-8"))
    out = []
    for rec in ds["mail"]:
        p = ds["personas"].get(rec.get("from", ""), {})
        if not p.get("email"):
            continue
        if not TIME_RE.match(rec.get("at", "")):
            raise Refused(f"dataset record of {rec['from']} has no HH:MM time")
        out.append({"key": rec["from"], "name": p["name"], "at": rec["at"], "subject": rec["subject"], "body": rec.get("body", "")})
    return out


def build_message(rec: dict, user: str, domain: str, day: dt.date, tz: dt.tzinfo) -> EmailMessage:
    """One RFC 822 message: From "<fullName>" <user+key@domain>, To the account, Date = `day` at the record's time."""
    hh, mm = (int(x) for x in rec["at"].split(":"))
    when = dt.datetime(day.year, day.month, day.day, hh, mm, tzinfo=tz)
    msg = EmailMessage(policy=SMTP)
    msg["From"] = Address(display_name=rec["name"], username=f"{user}+{rec['key']}", domain=domain)
    msg["To"] = Address(username=user, domain=domain)
    msg["Subject"] = rec["subject"]
    msg["Date"] = format_datetime(when)
    msg["Message-ID"] = make_msgid(domain=MSGID_DOMAIN)
    msg.set_content(rec["body"], subtype="plain", charset="utf-8")
    return msg


def check_label(label: str) -> str:
    if not LABEL_RE.match(label) or label.lower() in SYSTEM or label.startswith("[") or "/" in label:
        raise Refused("the label must be a plain name (letters, digits, . _ -), not a system folder")
    return label


def split_account(account: str) -> tuple[str, str]:
    m = re.fullmatch(r"([A-Za-z0-9._-]{1,64})@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)", account.strip())
    if not m:
        raise Refused("BRIEF_IMAP_USER is not a plain address (no '+', no display name)")
    return m.group(1), m.group(2)


def quote(name: str) -> str:
    return '"' + name + '"'


def append_all(imap, label: str, messages: list[tuple[EmailMessage, dt.datetime]]) -> int:
    """CREATE the label when LIST does not show it, then APPEND each message to it. No SELECT, no other folder."""
    typ, data = imap.list('""', quote(label))
    exists = typ == "OK" and any(d for d in (data or []) if d)
    if not exists:
        typ, _ = imap.create(quote(label))
        if typ != "OK":
            raise Refused("could not create the label")
    n = 0
    for msg, when in messages:
        typ, _ = imap.append(quote(label), "", imaplib.Time2Internaldate(when), msg.as_bytes(policy=SMTP))
        if typ != "OK":
            raise Refused(f"APPEND refused after {n} messages")
        n += 1
    return n


def main(argv: list[str] | None = None, env: dict | None = None, imap_factory=None, today: dt.date | None = None) -> int:
    env = os.environ if env is None else env
    ap = argparse.ArgumentParser(description="Seed the Brief Gmail label over IMAP (APPEND only).")
    ap.add_argument("--dry-run", action="store_true", help="no network; print the messages with USER and DOMAIN")
    ap.add_argument("--only", metavar="KEY", help="append only the mail of this persona key")
    ap.add_argument("--label", default=DEFAULT_LABEL, help=f"the label (default {DEFAULT_LABEL})")
    args = ap.parse_args(argv)
    try:
        label = check_label(args.label)
        tz = ZoneInfo(DISPLAY_TZ)
        day = today or dt.datetime.now(tz).date()
        records = load_records()
        if args.only is not None:
            records = [r for r in records if r["key"] == args.only]
            if not records:
                raise Refused("--only: no persona mail with that key")

        if args.dry_run:
            for i, rec in enumerate(records, 1):
                msg = build_message(rec, "USER", "DOMAIN", day, tz)
                print(f"----- message {i} of {len(records)} -> label {label} -----")
                print(msg.as_string(policy=SMTP.clone(linesep="\n")).rstrip("\n"))
            print(f"dry run: {len(records)} messages built for label {label}; no network, nothing appended")
            return 0

        account = env.get("BRIEF_IMAP_USER", "")
        password = env.get("BRIEF_IMAP_APP_PASSWORD", "")
        missing = [n for n, v in (("BRIEF_IMAP_USER", account), ("BRIEF_IMAP_APP_PASSWORD", password)) if not v]
        if missing:
            raise Refused(f"{' and '.join(missing)} not set in the environment; nothing done")
        user, domain = split_account(account)
        messages = []
        for rec in records:
            msg = build_message(rec, user, domain, day, tz)
            hh, mm = (int(x) for x in rec["at"].split(":"))
            messages.append((msg, dt.datetime(day.year, day.month, day.day, hh, mm, tzinfo=tz)))

        factory = imap_factory or (lambda: imaplib.IMAP4_SSL(HOST, PORT, ssl_context=ssl.create_default_context()))
        try:
            imap = factory()
        except (OSError, imaplib.IMAP4.error) as e:
            raise Refused(f"could not open a verified TLS connection to the IMAP server ({type(e).__name__})") from None
        try:
            try:
                imap.login(account, password)
            except imaplib.IMAP4.error:
                raise Refused("IMAP login refused (check the app password)") from None
            n = append_all(imap, label, messages)
        except (OSError, imaplib.IMAP4.error) as e:  # D3 review, note 11: a dropped connection = one plain line too
            raise Refused(f"IMAP error ({type(e).__name__})") from None
        finally:
            try:
                imap.logout()
            except Exception:
                pass
        print(f"done: {n} messages appended to label {label}")
        return 0
    except Refused as e:
        print(f"seed_label: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
