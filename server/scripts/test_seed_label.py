"""Tests of seed_label.py: the message builder, --dry-run, the refusals. No network: IMAP is a fake object.

  cd app/server && python3 -m unittest discover -s scripts -p 'test_*.py'
"""
import contextlib
import datetime as dt
import email
import io
import subprocess
import sys
import unittest
from email.policy import default
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parent))
import seed_label  # noqa: E402

HERE = Path(__file__).resolve().parent
TZ = ZoneInfo("America/Toronto")
DAY = dt.date(2026, 11, 23)
# Made-up credentials for the tests only (example.org, never a real account).
ENV = {"BRIEF_IMAP_USER": "owner.test@example.org", "BRIEF_IMAP_APP_PASSWORD": "not-a-real-password"}


class FakeImap:
    """Records every IMAP command; LIST answers as Gmail does for an absent / present folder."""

    def __init__(self, label_exists=False, fail_login=False):
        self.calls = []
        self.label_exists = label_exists
        self.fail_login = fail_login

    def login(self, user, password):
        self.calls.append(("login",))
        if self.fail_login:
            raise seed_label.imaplib.IMAP4.error("[AUTHENTICATIONFAILED] Invalid credentials (Failure)")
        return "OK", [b"ok"]

    def list(self, ref, pattern):
        self.calls.append(("list", pattern))
        return "OK", ([b'(\\HasNoChildren) "/" "brief-demo"'] if self.label_exists else [None])

    def create(self, name):
        self.calls.append(("create", name))
        return "OK", [b"ok"]

    def append(self, mailbox, flags, date_time, message):
        self.calls.append(("append", mailbox, message))
        return "OK", [b"ok"]

    def logout(self):
        self.calls.append(("logout",))
        return "BYE", [b""]


def run(argv, env=None, imap=None):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = seed_label.main(argv, env=env if env is not None else {}, imap_factory=(lambda: imap) if imap else _no_network, today=DAY)
    return code, out.getvalue(), err.getvalue()


def _no_network():
    raise AssertionError("the test tried to open a network connection")


class Builder(unittest.TestCase):
    def test_records_are_the_four_persona_mails(self):
        recs = seed_label.load_records()
        self.assertEqual([r["key"] for r in recs], ["marco", "priya", "jordan", "lina"])

    def test_message_headers_and_body(self):
        rec = seed_label.load_records()[0]
        msg = seed_label.build_message(rec, "owner.test", "example.org", DAY, TZ)
        parsed = email.message_from_bytes(msg.as_bytes(), policy=default)
        self.assertEqual(str(parsed["From"]), "Marco Bellini <owner.test+marco@example.org>")
        self.assertEqual(str(parsed["To"]), "owner.test@example.org")
        self.assertEqual(str(parsed["Subject"]), "Friday 6 am")
        when = parsed["Date"].datetime
        self.assertEqual((when.date(), when.hour, when.minute), (DAY, 11, 2))
        self.assertEqual(when.utcoffset(), dt.timedelta(hours=-5))
        self.assertRegex(str(parsed["Message-ID"]), r"^<[^@<>]+@brief-demo\.invalid>$")
        self.assertEqual(parsed.get_content_type(), "text/plain")
        self.assertEqual(parsed.get_content_charset(), "utf-8")
        self.assertEqual(parsed.get_content().strip(), rec["body"])

    def test_message_ids_are_fresh(self):
        rec = seed_label.load_records()[0]
        ids = {seed_label.build_message(rec, "u", "example.org", DAY, TZ)["Message-ID"] for _ in range(5)}
        self.assertEqual(len(ids), 5)

    def test_utf8_body_and_name(self):
        rec = {"key": "lina", "name": "Lína Chen", "at": "08:55", "subject": "Café order", "body": "Déjà vu, line 3."}
        parsed = email.message_from_bytes(seed_label.build_message(rec, "u", "example.org", DAY, TZ).as_bytes(), policy=default)
        self.assertEqual(parsed.get_content().strip(), "Déjà vu, line 3.")
        self.assertEqual(parsed["From"].addresses[0].display_name, "Lína Chen")


class DryRun(unittest.TestCase):
    def test_prints_four_messages_with_placeholders_only(self):
        code, out, err = run(["--dry-run"], env=ENV)
        self.assertEqual(code, 0, err)
        self.assertEqual(out.count("----- message "), 4)
        self.assertEqual(out.count("\nFrom: "), 4)
        self.assertIn("USER+marco@DOMAIN", out)
        self.assertIn("To: USER@DOMAIN", out)
        self.assertNotIn("owner.test", out)
        self.assertNotIn("example.org", out)
        self.assertNotIn("not-a-real-password", out)
        for real in ("northline-automation", "riverside-foods", "kestrel-supply", "acme-packaging"):
            self.assertNotIn(real, out)

    def test_dry_run_only_one(self):
        code, out, _ = run(["--dry-run", "--only", "lina"])
        self.assertEqual(code, 0)
        self.assertEqual(out.count("----- message "), 1)
        self.assertIn("USER+lina@DOMAIN", out)

    def test_cli_dry_run_subprocess(self):
        env = {"PATH": "/usr/bin:/bin", **ENV}
        r = subprocess.run([sys.executable, str(HERE / "seed_label.py"), "--dry-run"], capture_output=True, text=True, env=env, timeout=30)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout.count("----- message "), 4)
        self.assertNotIn("owner.test", r.stdout + r.stderr)


class Refusals(unittest.TestCase):
    def test_absent_credentials_refused_before_any_network(self):
        for env in ({}, {"BRIEF_IMAP_USER": ENV["BRIEF_IMAP_USER"]}, {"BRIEF_IMAP_APP_PASSWORD": ENV["BRIEF_IMAP_APP_PASSWORD"]}):
            code, out, err = run([], env=env)
            self.assertEqual(code, 1)
            self.assertIn("not set in the environment", err)
            self.assertEqual(out, "")
            self.assertNotIn("owner.test", err)
            self.assertNotIn("not-a-real-password", err)

    def test_bad_label_and_unknown_key(self):
        for label in ("INBOX", "[Gmail]/Sent Mail", "a/b", "", "spam"):
            code, _, err = run(["--dry-run", "--label", label])
            self.assertEqual(code, 1, label)
            self.assertIn("plain name", err)
        code, _, err = run(["--dry-run", "--only", "sam"])
        self.assertEqual(code, 1)
        self.assertIn("--only", err)

    def test_account_with_plus_refused(self):
        code, _, err = run([], env={**ENV, "BRIEF_IMAP_USER": "owner+x@example.org"})
        self.assertEqual(code, 1)
        self.assertNotIn("owner", err)

    def test_login_refused_plain_line(self):
        imap = FakeImap(fail_login=True)
        code, out, err = run([], env=ENV, imap=imap)
        self.assertEqual(code, 1)
        self.assertIn("login refused", err)
        self.assertNotIn("owner.test", out + err)
        self.assertNotIn("append", [c[0] for c in imap.calls])

    def test_connection_dropped_plain_line(self):
        # D3 review, note 11: an OSError during APPEND printed a traceback instead of one plain line
        class Dropping(FakeImap):
            def append(self, mailbox, flags, date_time, message):
                raise ConnectionResetError("connection reset by peer")

        code, out, err = run([], env=ENV, imap=Dropping(label_exists=True))
        self.assertEqual(code, 1)
        self.assertEqual(len(err.strip().splitlines()), 1)
        self.assertNotIn("Traceback", err)
        self.assertNotIn("owner.test", out + err)


class LivePathOnAFake(unittest.TestCase):
    def test_creates_label_when_absent_then_appends_only_there(self):
        imap = FakeImap(label_exists=False)
        code, out, err = run([], env=ENV, imap=imap)
        self.assertEqual(code, 0, err)
        self.assertEqual([c[0] for c in imap.calls], ["login", "list", "create"] + ["append"] * 4 + ["logout"])
        self.assertTrue(all(c[1] == '"brief-demo"' for c in imap.calls if c[0] in ("create", "append")))
        self.assertNotIn("owner.test", out + err)
        self.assertIn("4 messages appended", out)

    def test_existing_label_not_created_and_only_one(self):
        imap = FakeImap(label_exists=True)
        code, out, _ = run(["--only", "priya", "--label", "brief-test"], env=ENV, imap=imap)
        self.assertEqual(code, 0)
        self.assertEqual([c[0] for c in imap.calls], ["login", "list", "append", "logout"])
        self.assertEqual(imap.calls[2][1], '"brief-test"')
        sent = email.message_from_bytes(imap.calls[2][2], policy=default)
        self.assertEqual(str(sent["From"]), "Priya Nair <owner.test+priya@example.org>")

    def test_never_sends(self):
        src = (HERE / "seed_label.py").read_text(encoding="utf-8")
        self.assertNotIn("smtplib", src)
        self.assertNotIn(".select(", src)


if __name__ == "__main__":
    unittest.main()
