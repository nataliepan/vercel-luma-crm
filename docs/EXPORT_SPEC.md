# Export Spec

> **Status: Planned — Out of scope for v1.**
> This feature is documented for future planning. It will not be built as part of the initial assessment project.

---

## Overview

Enable contact data to be exported in formats compatible with external newsletter platforms (e.g., Beehiiv, Mailchimp, ConvertKit), allowing a smooth handoff from the CRM to distribution tools.

---

## Planned Features

- **CSV export**: Standard format importable by most newsletter platforms
- **JSON export**: For platforms with API-based list management
- **Field mapping per platform**: Different platforms expect different column names — export should adapt accordingly
- **Filtered exports**: Export only a segment (e.g., by tag, by event attended, by last seen date)
- **Unsubscribe flagging**: Contacts who have opted out should be excluded or flagged in exports

---

## Planned Export Fields

| CRM Field | Exported As | Notes |
|-----------|-------------|-------|
| `first_name` | `First Name` | |
| `last_name` | `Last Name` | |
| `email` | `Email` | Required |
| `company` | `Company` | |
| `job_title` | `Job Title` | |
| `tags` | `Tags` | Comma-separated |
| `total_events_attended` | `Events Attended` | Engagement signal |
| `last_event_date` | `Last Seen` | |

---

## Open Questions (For Future Planning)

- [ ] Which platforms should be supported at launch of this feature?
- [ ] Should export be one-click download or scheduled/automated?
- [ ] How should unsubscribes from the newsletter platform sync back to the CRM?
- [ ] Should we support direct API push to platforms (e.g., Mailchimp API) vs. file download only?
