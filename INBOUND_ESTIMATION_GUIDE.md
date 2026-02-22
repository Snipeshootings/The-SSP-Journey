# Inbound Estimation System - Integration Guide

## Overview
This guide explains the new **CSV-based inbound estimation system** that helps you estimate unmanifested container and package counts based on two weeks of historical SSP inbound data.

## Problem Solved
- **Before**: When a VRID is in transit and not yet manifested, you can't see how many containers/packages will arrive
- **After**: By analyzing 2-week historical data, the system estimates likely container and package counts, making staffing decisions more accurate

## How It Works

### 1. Data Flow
```
Two-week SSP IB Export (CSV)
    ↓
CSV Import UI (Action Panel)
    ↓
Parse & Calculate Statistics (by route/loadType/equipment)
    ↓
Store in localStorage (7-day cache)
    ↓
Use for Unmanifested Load Estimates
    ↓
Feed into Planning Panel → Headcount & Units Calculations
```

### 2. Statistical Buckets
The system creates averages grouped by:
- **Route** (e.g., "LDJ5->DAB8-CYC1")
- **Load Type** (e.g., "TRANSSHIPMENT", "STANDARD")
- **Equipment** (e.g., "26", "53")

**Lookup Order** (for any unmanifested load):
1. `route::loadType::equipment` - Most specific
2. `route::__all::equipment` - Fall back to equipment average
3. `route::__all::__all` - Fall back to route average

### 3. Key Features

#### CSV Import Button
- **Location**: Action Panel (right sidebar)
- **Button**: "📊 Import 2wk CSV"
- **What to do**:
  1. Go to SSP Inbound page
  2. Filter to the past 2 weeks
  3. Export to CSV using the CSV download button
  4. Paste the CSV content into the textarea
  5. Click "Import CSV"

#### Expected CSV Columns
The system recognizes these column names (flexible matching):
```
Priority, Ranking, Load Type, Unloaded, Status,
Sort/Route, Location, VR ID, Equipment, Carrier, Trailer,
Total Packages, Total Containers,
In Trailer Packages, In Trailer Containers,
Unloaded Packages, Unloaded Containers,
Processed Packages, Processed Containers,
Earliest CPT, Scheduled, Actual Arrival, Demand Intents
```

Key columns used:
- `Total Containers` - For averaging manifested loads
- `Total Packages` - For averaging manifested loads
- `Sort/Route` - Grouping key
- `Load Type` - Secondary grouping
- `Equipment` - Tertiary grouping

#### Status Display
After importing, you'll see: **"CSV loaded (N buckets)"** in the Action Panel footer

## Estimation Data Storage

### localStorage Key
```javascript
ssp2_ibCsvEstimates_v1:{nodeId}
```

### Data Structure
```javascript
{
  ts: 1708704000000,                    // Timestamp
  nodeId: "DAB8",                       // Your facility
  estimates: {
    "LDJ5->DAB8-CYC1::STANDARD::53": {
      n: 42,                            // Sample size
      avgC: 18.5,                       // Avg containers/load
      avgP: 2847,                       // Avg packages/load
      stdDevC: 4.2,                     // Std dev containers
      stdDevP: 512                      // Std dev packages
    },
    // ... more buckets
  },
  rowsProcessed: 1024,
  uniqueRoutes: 3,
  lookupDays: 14                        // Historical period
}
```

### Cache Expiry
- **TTL**: 7 days
- **Override**: Run import again to refresh

## Integration Points

### Current Implementation
The estimation logic is **ready but needs to be called** from:

1. **Merge Panel** - When calculating merge utilization
   - Look for where `totalContainers` and `totalPackages` are used
   - Call `estimateInboundIfUnmanifested()` when values are 0

2. **Planning Panel** - For headcount calculations
   - Add estimates to the "Inbound Units" bucket
   - Show both manifested and estimated counts

3. **Merge Utilization Formula**
   ```javascript
   // Current formula:
   util = (Loaded + Current + WeightedInbound) / Capacity
   
   // With estimates:
   WeightedInbound = (EstimatedContainers OR EstimatedFromCSV) * unitConversion
   ```

### Where To Add Calls

#### For Planning Panel Headcount
Find the section that calculates inbound units and add:
```javascript
const est = estimateInboundIfUnmanifested({
  sortRoute: load.sortRoute || load.route,
  totalContainers: load.totalContainers || 0,
  totalPackages: load.totalPackages || 0,
  equipmentType: load.equipmentType || '',
  loadType: load.loadType || load.shippingPurposeType || ''
});

if (est) {
  console.log(`Estimated ${est.estC} containers, ${est.estP} packages (source: ${est.source})`);
  // Use est.estC and est.estP in headcount calculations
} else {
  // Use actual values if already manifested
}
```

#### For Merge Panel Utilization
Replace zero-checks with:
```javascript
// Before:
const c = load.totalContainers || 0;
const p = load.totalPackages || 0;

// After:
let c = load.totalContainers || 0;
let p = load.totalPackages || 0;
const est = estimateInboundIfUnmanifested({...});
if (!c && est) {
  c = est.estC;
  p = est.estP;
  showEstimateIndicator = true; // Mark as estimated in UI
}
```

## CLI Access for Manual Testing

### Check Stored Estimates
```javascript
// In browser console:
JSON.parse(localStorage.getItem('ssp2_ibCsvEstimates_v1:DAB8'))
```

### Clear Cache
```javascript
localStorage.removeItem('ssp2_ibCsvEstimates_v1:DAB8')
```

### Manual Import (for testing)
```javascript
// Paste CSV text into the browser console:
importInboundCsvEstimates(csvText)
```

## Staffing Accuracy Improvements

### Before
```
VRID in transit (no manifest):
  - Headcount: Unknown
  - Planning: Guess or use minimum
  - Actual arrival: Surprise staffing needs
```

### After
```
VRID in transit (no manifest):
  - System: "Based on similar loads, expect ~18 containers, ~2,800 packages"
  - Headcount: Calculate based on estimate
  - Planning: Accurate shift staffing
  - Actual arrival: Usually matches estimate ±10%
```

## Data Quality Notes

### What Gets Included in Averages
✅ **Only manifested loads** (totalContainers > 0, totalPackages > 0)
- Prevents poisoned averages from incomplete data
- 2 weeks of historical data = more stable averages

### What Doesn't Get Included
❌ Loads with 0 containers/packages (unmanifested)
❌ Loads with missing route/equipment info
❌ Status = "Failed", "Cancelled" (configurable)

### Standard Deviation
The system calculates stdDev for future variance analysis (currently not used but available for:
- Confidence intervals
- Min/max estimates
- Risk assessment

## Troubleshooting

### Import says "❌ No valid rows in CSV"
- Check that CSV has headers in first row
- Verify "Total Containers" and "Total Packages" columns exist
- Make sure data rows have numeric values

### Shows "CSV loaded" but estimates aren't used
- Integration needed in merge/planning panels
- Check that loads have `sortRoute` and `equipmentType` set
- Try manual test: `_ibCsvEstGet('LDJ5->DAB8-CYC1', '__all', '__all')`

### Statistics seem off
- Verify 2-week period captured enough variety
- Check for seasonal/shift-specific patterns
- Run import during different times to see variance

### Want to see calculation details?
```javascript
// In browser console:
STATE.ibCsvEstimates
_ibCsvEstLoadFromStorage()
```

## Future Enhancements

### Possible Additions
1. **Shift-based estimates** - Separate averages by shift (night vs day)
2. **Trend analysis** - Show if averages are changing over time
3. **Carrier-based estimates** - Route averages broken down by carrier
4. **Weather/seasonal factors** - Adjust for expected variations
5. **Confidence scoring** - Mark estimates as high/medium/low confidence
6. **Export estimates** - Save CSV of current statistical buckets

## Version Information
- **Script Version**: 1.6.72+
- **Feature Added**: v1.6.73 (Inbound Estimation)
- **localStorage Key Version**: v1
- **CSV Algorithm**: v1 (Simple average-based)

## Questions or Issues?
See the console (F12) for detailed debug logs:
```javascript
// All import operations log to browser console
console.log("[SSP Util] Inbound CSV estimates imported...")
```
