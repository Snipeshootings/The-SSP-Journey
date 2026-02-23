# Slack Notifications Setup Guide

## Overview
SSP Util now includes **Slack notifications** for pushing urgent messages and escalations directly to your team's Slack workspace.

## Quick Start

### 1. Create a Slack Webhook
1. Go to [api.slack.com/apps](https://api.slack.com/apps)
2. Click **"Create New App"** → **"From scratch"**
3. Name your app (e.g., "SSP Util") and select your workspace
4. Go to **"Incoming Webhooks"** in the left sidebar
5. Toggle **"Activate Incoming Webhooks"** to ON
6. Click **"Add New Webhook to Workspace"**
7. Select the channel where you want notifications (e.g., #ssp-alerts)
8. Click **"Allow"**
9. Copy the **Webhook URL** (looks like: `https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX`)

### 2. Configure in SSP Util
1. Load the SSP dashboard with SSP Util installed
2. Look for the **"📤 Slack"** button in the Action Panel (right sidebar)
3. Click it to open the configuration modal
4. Paste your webhook URL into the **"Webhook URL"** field
5. ✅ Check **"Enable Slack notifications"** if you want them active
6. Click **"Test Message"** to verify it works
7. Click **"Save"** to store the configuration

### 3. Test Notifications
The configuration modal includes a **"Test Message"** button that sends a test notification to your configured channel to verify everything is working.

## Using Slack Notifications

### Send Messages from DevTools Console
You can manually send messages from the browser DevTools console:

```javascript
// Simple text message
await sendSlackMessage("⚠️ Capacity alert on CPT 14:30!");

// Formatted message with Slack formatting
await sendSlackMessage("*URGENT:* Load group LDJ5->DAB8 is at 95% capacity");

// Multi-line with details
await sendSlackMessage(`*Load Status Alert*
Lane: LDJ5->DAB8-CYC1
Status: Merge Now
Capacity: 92%
CPT: 14:30`);
```

### Message Formatting
Slack supports these formatting options:
- `*text*` = **bold**
- `_text_` = _italic_
- `` `text` `` = `code`
- `~text~` = ~~strikethrough~~
- `>text` = blockquote (at start of line)

### Example Urgent Messages

**Capacity Alert:**
```
*🚨 CAPACITY ALERT*
Lane: LDJ5->DAB8-CYC1
Status: Merge Now
Available: 4 carts | Projected: 36 carts
CPT: 14:30 (30 mins away)
Action: Merge inbound load immediately
```

**Escalation:**
```
*URGENT: Late Inbound Load*
VRID: ABC123456XYZ
Status: Delayed
Expected: 14:15 → Actual: 14:45
Impact: All downstream lanes affected
```

**Configuration Change:**
```
SSP Util Configuration Updated
- Merge threshold: 85%
- Equipment: 53' trailers
- Capacity per load: 36 carts
Updated at: 14:25 by ops_user
```

## Configuration Storage
- **Webhook URL** and **Enabled status** are stored in browser localStorage
- Configuration persists across browser sessions
- Each machine/browser has independent configuration

## Security Notes
- ⚠️ **Never share your webhook URL** publicly — anyone with it can post to your channel
- Webhook URLs are stored in browser localStorage (not encrypted)
- To rotate/revoke a webhook: go to [api.slack.com/apps](https://api.slack.com/apps) and delete the webhook
- Create separate apps/webhooks for different environments (test vs production)

## Troubleshooting

### "Failed: 403" Error
- Check webhook URL is correct and hasn't been revoked
- Verify the webhook is still active in your Slack app settings

### "Failed: 404" or "Invalid"
- Webhook URL is malformed or typo
- Copy the URL directly from [api.slack.com](https://api.slack.com/apps)

### Message Not Appearing
- Verify the webhook is enabled in your Slack app
- Check that you selected the correct channel (webhook is bound to specific channel)
- Confirm "Enable Slack notifications" is checked in configuration

### How to View Webhook Details
1. Go to [api.slack.com/apps](https://api.slack.com/apps)
2. Select your app
3. Click **"Incoming Webhooks"**
4. Find your webhook and click the copy icon to get the URL

## Future Enhancements
- Automatic escalations on capacity threshold breaches
- Driver notifications for route assignments
- Inbound ETA alerts when loads are delayed
- Critical pull time (CPT) countdown alerts
- Merge panel automation notifications
- Integration with Slack slash commands for dashboard queries

## Questions?
- Review Slack API docs: [api.slack.com/incoming-webhooks](https://api.slack.com/incoming-webhooks)
- Check SSP Util console for error messages: `[SSP Util]` prefix
 
 ## Workflow trigger (alternate)
The Slack Workflow Builder can expose a webhook trigger that runs a configured workflow when your userscript POSTs to it. This is convenient when you want Slack to run a sequence of steps (e.g., post formatted message, run additional actions) without creating a full app.

Setup:
1. Open Slack → Workflow Builder
2. Create a new workflow and choose the trigger "Webhook" (or "Incoming webhook trigger")
3. Add the workflow step "Send a message"
4. Save the workflow and copy the provided trigger URL
5. Paste the trigger URL into the "Workflow Trigger URL" field in SSP Util's Slack config modal

### Canonical SSP Util payload schema (stable snake_case)
SSP Util now sends a standardized payload for workflow triggers and incoming webhooks. Field names are intentionally snake_case so Workflow Builder variable mapping remains stable across versions.

```json
{
  "alert_type": "capacity_breach",
  "severity": "critical",
  "site": "LDJ5",
  "lane": "LDJ5->DAB8-CYC1",
  "vrid": "AB1234567890CD",
  "container_id": "CART-2024-001",
  "disruption_type": "linehaul_delay",
  "adhoc_needed": false,
  "late_package_count": 18,
  "cpt": "14:30",
  "utilization_pct": 94,
  "timestamp_iso": "2026-02-23T14:22:10.000Z",
  "message": "[CRITICAL] capacity_breach for LDJ5->DAB8-CYC1",
  "text": "[CRITICAL] capacity_breach for LDJ5->DAB8-CYC1"
}
```

### Workflow Builder variable mapping guidance
In your Workflow "Send a message" step, map these variables directly from the webhook payload:

- `alert_type` → alert category (`capacity_breach`, `adhoc_needed`, `late_packages`, etc.)
- `severity` → urgency (`info`, `warning`, `critical`)
- `site`, `lane`, `vrid`, `container_id` → operational identifiers
- `disruption_type` → disruption reason/category
- `adhoc_needed` → boolean flag for extra capacity requirement
- `late_package_count` → numeric package delay count
- `cpt`, `utilization_pct`, `timestamp_iso` → time/capacity context
- `message` (or `text`) → human-readable fallback text for Slack post body

Compatibility notes:
- `text` is included for Incoming Webhook compatibility.
- `message` mirrors `text` and is preferred for workflow readability.
- Keep workflow mappings pointed at these stable snake_case keys to avoid breakage on future releases.

Example payload to trigger a workflow (from browser console or userscript):
```javascript
await fetch('YOUR_WORKFLOW_URL', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(buildSlackPayload('capacity_breach', {
    severity: 'critical',
    site: 'LDJ5',
    lane: 'LDJ5->DAB8-CYC1',
    vrid: 'AB1234567890CD',
    cpt: '14:30',
    utilization_pct: 94,
    late_package_count: 18,
    message: '[CRITICAL] capacity_breach for LDJ5->DAB8-CYC1'
  }))
});
```
