# Why this is archived, not active

Built 2026-08-19 as a scaffold for a fourth Ink2Task backend: Apple Reminders
synced directly via CalDAV, to avoid depending on a local Mac + EventKit
(`mac-server`) so it could run serverless.

The client code works correctly -- discovery, list filtering, fetch, and
write-back all functioned as designed when tested against a real iCloud
account. The problem is what's on the other end: Apple moved primary
Reminders sync to a proprietary protocol starting around iOS 13 ("New
Reminders"). For an account on that protocol (the default for essentially
everyone at this point):

- Most real reminder lists never show up in CalDAV discovery at all.
- The few that do show up return only placeholder junk instead of real data
  -- literally `"The creator of this list has upgraded these reminders."` /
  `"Where are my reminders?"`, verified live against a real account.
- There's no system setting (checked macOS System Settings > iCloud) that
  restores legacy CalDAV access.

Confirmed on the account: 2 lists were reachable via CalDAV at all, and both
of them were placeholder-only. Every other list in the real Reminders app
was invisible to CalDAV entirely.

**Conclusion:** this isn't a bug to keep patching -- it's an Apple-side
platform limitation. EventKit (what `mac-server` already uses) is the only
API that reaches real Reminders data, and it only runs inside macOS/iOS
itself, so there's no serverless path around needing an always-on Apple
device. See the top-level conversation/commit history around this date for
the fuller investigation if Apple ever changes this and it's worth
revisiting.
