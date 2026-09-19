# Private calendar export

Status: implemented for canonical accepted primary-circle schedules and
flag-enabled selected-secondary schedules

The dashboard shows **Add to calendar** only when the authenticated current
pair has a canonical primary room, or a selected secondary pair has a verified
opaque schedule identity, and its schedule contains a normalized UTC accepted
instant. The action creates an RFC 5545 `.ics` file entirely in the browser.
There is no calendar API, server endpoint, database write, analytics event, or
third-party request.

## File contract

Each export contains one event with:

- a UTC `DTSTART` matching the current accepted instant;
- a `DTEND` exactly 60 minutes later;
- a stable UID derived only from the canonical room or opaque secondary
  schedule identity, so a later export after a reschedule identifies the same
  logical event;
- the current app origin's authenticated room link for primary schedules or
  dashboard-only link for secondary schedules; and
- generic Randori summary and privacy/retention copy.

The file is a plain static calendar import and deliberately omits the iTIP
`METHOD` property: Randori is not acting as an organizer or remote calendar
publisher. It does not receive a partner name or email, invitation or session
token, source code, chat, transcript, answer, or other workspace content. RFC text is
escaped and lines are folded to the 75-octet limit. Invalid or non-normalized
timestamps, proposals, legacy free-text agreements, and cleared agreements do
not expose the action.

The duration is deliberately fixed at 60 minutes until duration is canonical
server data. Importing the file creates a copy outside Randori: the member's
calendar application controls that copy, including its retention, sharing,
reminders, and deletion. Clearing a Randori agreement removes the export action
but cannot remove a file or event already imported elsewhere.

## Reschedule and recovery

A reschedule rerenders the action from the new canonical schedule version. The
next file retains the primary room UID or opaque secondary schedule UID and
carries the new UTC start and end. Calendar applications decide how duplicate
imports are reconciled; Randori does not claim remote calendar synchronization.

The export itself has no provider configuration. Secondary export visibility
depends on `SECONDARY_CIRCLE_SCHEDULING_ENABLED`; recovery disables that flag
without changing primary export. Existing downloaded files remain under the
member's control and cannot be revoked by Randori.

## Alternatives

- Google Calendar or Outlook URLs were rejected because they are
  vendor-specific and disclose event data to another service.
- A server-generated download was rejected because deterministic formatting
  does not justify another authenticated endpoint or retention surface.
- Calendar-provider OAuth and two-way sync were deferred because they require
  broad permissions, token storage, provider-specific conflict handling, and a
  materially larger privacy review.
