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
