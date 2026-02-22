# SSP Util Slack Notifications - Usage Examples

## Quick Test
Paste in browser DevTools console to test your Slack connection:

```javascript
// Test basic connectivity
await sendSlackMessage("✅ SSP Util Slack integration working!");
```

## Capacity & Merge Alerts

### Critical Capacity Warning
```javascript
await sendSlackMessage(`
*🚨 CRITICAL CAPACITY ALERT*
Lane: LDJ5→DAB8-CYC1
Status: MERGE NOW
Current: 28/36 carts (78%)
Projected: 34/36 carts (94%)
Time to CPT: 25 minutes
_Recommendation: Trigger merge immediately_
`);
```

### Merge Soon Notification
```javascript
await sendSlackMessage(`
*⚠️ MERGE SOON - Lane Action Required*
Lane: LDJ5→DAB8-CYC1
Current Utilization: 85%
Equipment: 53' trailers
Action: Prepare for merge in next cycle
CPT: 15:30
`);
```

### Adhoc Overage Alert
```javascript
await sendSlackMessage(`
*📦 ADHOC OVERAGE DETECTED*
Lane: AMZ7→PHX2
Projected Volume: 40 carts
Capacity: 36 carts
Overage: +4 carts
Status: Recommend additional load
`);
```

## Escalation & Disruption Alerts

### Delayed Inbound Load
```javascript
await sendSlackMessage(`
*🔴 DELAYED INBOUND LOAD*
VRID: AB1234567890CD
Route: LDJ5→HTL8
Expected Arrival: 14:15
Current Status: In Transit
Delay: 45 minutes
Impact: Downstream lanes will be slowed
_Next Update: 14:45_
`);
```

### Container Move Failure
```javascript
await sendSlackMessage(`
*❌ CONTAINER MOVE FAILED*
Container: CART-2024-001
From: DOCK-A
To: STAGING-B
Reason: Equipment unavailable
Resolution: Manual move required
Assigned to: @ops_team
`);
```

### Carrier No-Show Alert
```javascript
await sendSlackMessage(`
*⛔️ CARRIER NO-SHOW ALERT*
Carrier: AZNG (V524925)
Scheduled Time: 13:00
Current Time: 13:45
Status: Not arrived
Containers Pending: 8
Action: Contact carrier for ETA update
`);
```

## Driver & Execution Updates

### Driver Assignment Notification
```javascript
await sendSlackMessage(`
*👤 New Driver Assignment*
VRID: AB1234567890CD
Driver: John Smith (ID: DRV-2024-001)
Route: LDJ5→HTL8
Departure Time: 15:00
Load: 24 carts
Contact: (555) 123-4567
`);
```

### Dock Door Assignment
```javascript
await sendSlackMessage(`
*🚪 DOCK DOOR ASSIGNMENT*
VRID: AB1234567890CD
Dock Door: DOOR-14
Load: OUTBOUND-2024-032
Expected Duration: 45 min
Status: Ready for unload
`);
```

## Planning & CPT Coordination

### CPT Countdown
```javascript
await sendSlackMessage(`
*⏰ CRITICAL PULL TIME COUNTDOWN*
Lane: LDJ5→DAB8-CYC1
CPT: 14:30
Time Remaining: *15 MINUTES*
Current Status: 92% capacity
Action: All remaining loads must be loaded
Manager: Please confirm readiness
`);
```

### End-of-Shift Summary
```javascript
await sendSlackMessage(`
*📊 SHIFT SUMMARY - Operation Center*
Shift: Morning (7:00-15:00)
Total Loads: 48
Completed: 46
On-Time: 44 (92%)
Late: 2
Issues: 1 (container damage)
Next Shift: 15:00
`);
```

## System & Configuration Alerts

### System Configuration Changed
```javascript
await sendSlackMessage(`
*⚙️ SSP Util Configuration Updated*
Setting: Merge threshold
Old Value: 85%
New Value: 88%
Changed By: user@domain.com
Timestamp: 14:30 today
_Affects all downstream calculations_
`);
```

### System Health Check
```javascript
await sendSlackMessage(`
*✅ System Health Check*
Status: Healthy
SSP Connection: Active
Inbound Loads: 23
Outbound Loads: 15
Total Capacity: 480 units
Utilization: 72%
Last Refresh: 30 seconds ago
`);
```

## Multi-Line Template Examples

### Generic Escalation Template
```javascript
const escalationMessage = (title, details) => {
  const lines = [
    `*${title}*`,
    ...Object.entries(details).map(([key, value]) => `${key}: ${value}`),
  ].join('\n');
  return sendSlackMessage(lines);
};

// Usage:
escalationMessage("🚨 CAPACITY ALERT", {
  "Lane": "LDJ5→DAB8",
  "Status": "MERGE NOW",
  "Utilization": "94%",
  "Action": "Trigger merge",
  "CPT": "14:30",
});
```

### Error Notification Template
```javascript
const sendSlackError = (context, error, details = {}) => {
  const msg = `
*❌ ERROR: ${context}*
Message: \`${String(error?.message || error)}\`
${Object.entries(details).map(([k, v]) => `${k}: \`${v}\``).join('\n')}
Time: <!date^${Math.floor(Date.now()/1000)}^{date_pretty} {time_secs}|${new Date().toISOString()}>
`;
  return sendSlackMessage(msg);
};

// Usage:
sendSlackError("Inbound CSV Import", new Error("Invalid format"), {
  File: "inbound_2024-02-22.csv",
  Line: "47",
  Expected: "CART route",
});
```

## Advanced: Send from Script Events

### Hook into merge decisions (example for extension)
```javascript
// Example: Send alert when merge state changes
const originalRenderPanel = window.renderPanel;
window.renderPanel = async function(...args) {
  const result = await originalRenderPanel?.apply(this, args);
  
  // Check if merge state changed and send Slack notification
  const mergeState = STATE?.mergeStats;
  if (mergeState && mergeState.now > 0) {
    await sendSlackMessage(
      `*⚠️ ${mergeState.now} lanes require MERGE NOW*\n` +
      `Soon: ${mergeState.soon} | Risk: ${mergeState.risk | 0}`
    );
  }
  
  return result;
};
```

## Slack Message Best Practices

1. **Use Emojis** for quick visual scanning: 🚨❌⚠️✅🔴🟡🟢
2. **Bold important info** with `*text*` 
3. **Keep messages concise** - avoid walls of text
4. **Use timestamps** - include when alert was triggered
5. **Include action items** - what should recipient do?
6. **Tag users/groups** - use @username or @channel for urgent items
7. **Link context** - include VRID, lane, CPT, etc.

## Console Helper Functions

Paste these in console for easier notification sending:

```javascript
// Quick capacity alert
const capacityAlert = (lane, util, cpts) => 
  sendSlackMessage(`*⚠️ ${lane}* – ${util}% utilized (${cpts} CPTs)`);

// Quick error alert  
const errorAlert = (msg) => 
  sendSlackMessage(`*❌ ${msg}*`);

// Quick success alert
const successAlert = (msg) => 
  sendSlackMessage(`*✅ ${msg}*`);

// Usage:
capacityAlert("LDJ5→DAB8-CYC1", 92, "14:30");
errorAlert("Inbound load delayed 45 minutes");
successAlert("All morning loads completed on time");
```

## Troubleshooting Alerts

If messages aren't reaching Slack:

1. Check webhook is configured: `getSlackConfig()`
2. Verify webhook URL: `console.log(getSlackConfig())`
3. Test basic send: `await sendSlackMessage("test")`
4. Check browser console for errors: `[SSP Util]` prefix
5. Verify Slack app is still active in [api.slack.com](https://api.slack.com/apps)
6. Check Slack workspace/channel still exists

---

**Questions?** See [SLACK_NOTIFICATIONS_SETUP.md](SLACK_NOTIFICATIONS_SETUP.md) for full documentation.

## Workflow Trigger Payload Examples

When configured to use a Workflow trigger, `sendSlackMessage()` will POST JSON to the Workflow URL. Example payloads:

```javascript
// Basic text + fields the workflow can reference
await fetch('YOUR_WORKFLOW_URL', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ text: '*🚨 ALERT* Lane LDJ5->DAB8', vrid: 'ABC123', lane: 'LDJ5->DAB8-CYC1' })
});

// From userscript convenience helper
await sendSlackMessage('*⚠️ MERGE NOW* Lane: LDJ5->DAB8', { vrid: 'ABC123', lane: 'LDJ5->DAB8-CYC1' });
```
