# Quick Start: Using the Inbound Estimation System

## Step 1: Export Your Historical Data (One-Time Setup)

1. **Go to SSP Inbound Dashboard**
   - Open: https://trans-logistics.amazon.com/ssp/dock/...

2. **Filter the Data**
   - Set date range: **Last 14 days**
   - Load Status: All or "Completed"
   - This captures typical load patterns

3. **Export to CSV**
   - Click the **CSV button** or export option
   - This gives you a file with all columns (Sort/Route, Total Containers, Total Packages, etc.)

4. **Copy the CSV Content**
   - Open the CSV file
   - Select all text (Ctrl+A)
   - Copy (Ctrl+C)

## Step 2: Import into the Estimation System

1. **Open SSP Util Action Panel**
   - You'll see a right-side panel with buttons

2. **Click the "📊 Import 2wk CSV" Button**
   - A textarea appears
   - ← Paste your CSV here →

3. **Paste Your CSV**
   - Right-click → Paste
   - Or Ctrl+V

4. **Click "Import CSV"**
   - Status: "⏳ Processing..."
   - After 1-2 seconds: "✅ Imported 1024 rows, 45 estimate buckets"

5. **Done!**
   - The system is now using your data
   - You'll see "CSV loaded (45 buckets)" at the bottom

## Step 3: Using the Estimates in Your Workflow

### In the Planning Panel
When you see a load with **no manifest data** (0 containers, 0 packages in transit):

**Before:**
```
VRID: VR-ABC123
Route: LDJ5->DAB8-CYC1
Total Containers: — (not manifested)
Total Packages: — (not manifested)
Status: SCHEDULED, ETA: 14:30
```

**After (with estimates):**
```
VRID: VR-ABC123
Route: LDJ5->DAB8-CYC1
Total Containers: ~18 (est, based on 42 similar loads)
Total Packages: ~2,847 (est, based on 42 similar loads)
Status: SCHEDULED, ETA: 14:30
Source: csv_42 — means 42 historical loads this route
```

### In the Merge Panel
Utilization calculation automatically includes estimates:

```
Merge Panel: LDJ5->DAB8-CYC1 (CPT 14:30)

Loaded:               28 units
Current:              15 units
Inbound (estimated):  18 units (← uses CSV estimates for unmanifested)
─────────────────────────────
Total:                61 units / 200 cap = 30.5% util ✓
```

## Step 4: Staffing Decisions (The Goal)

### Example Scenario

**Monday 06:00 - Two weeks of data imported**

| Load | Manifest | Containers | Packages | Est Source | Headcount |
|------|----------|------------|----------|------------|-----------|
| VRID-001 | Yes | 12 | 1,200 | Actual | 3 FT |
| VRID-002 | No | ~18 | ~2,847 | csv_42 | **5 FT** |
| VRID-003 | Yes | 8 | 950 | Actual | 2 FT |
| VRID-004 | No | ~22 | ~3,100 | csv_38 | **6 FT** |

**Without estimates:**
- Only 2 manifested loads visible → Plan for 5 FT

**With estimates:**
- All 4 loads estimated → Plan for 16 FT

**Result:**
- Enough staff to handle actual demand
- Reduced overtime
- Better CPT performance

## Step 5: Periodic Refresh (Daily/Weekly)

### Keep Estimates Current
- **Frequency**: Every 3-5 days during active season
- **How**: Repeat Steps 1-2 with fresh 14-day export
- **Duration**: 2-week lookback always = rolling window
- **Cache**: Automatically expires after 7 days

### Seasonality Adjustments
- High season (Q4): Import on Monday for the week ahead
- Low season: Weekly or bi-weekly
- Holiday periods: Import special 14-day periods just before

## Common Questions

### Q: What if an estimate is wrong?
**A:** The system shows the source (csv_42 = based on 42 loads). One wrong load won't skew it much, but if you see consistent mismatches:
- Check if load type/route has changed
- Re-import after 5 days to get fresh data
- Estimates get better with more data

### Q: Can I see the detailed statistics?
**A:** Yes, via browser console:
```javascript
// Open DevTools (F12), go to Console tab
STATE.ibCsvEstimates
```

This shows every bucket:
- `route::loadType::equipment` → avgC, avgP, stdDev, sample size

### Q: What if I don't want to use estimates for a specific load?
**A:** The system only uses estimates when manifested data is missing (0 containers, 0 packages). Once a load gets manifested, estimates are ignored.

### Q: Can I export the estimates to share with my team?
**A:** Not yet, but you could:
1. Screenshot the status
2. Tell them: "CSV loaded with 45 statistical buckets"
3. They can repeat the import themselves

## Data Quality Checklist

Before importing, check your CSV has:

- [ ] Header row with column names
- [ ] At least 20 rows of data (more = better)
- [ ] "Total Containers" and "Total Packages" columns with numbers
- [ ] "Sort/Route" column (or similar route identifier)
- [ ] "Equipment" column (or type info)
- [ ] Mix of load types (not all one type)
- [ ] No corrupted rows (watch for weird characters)

## Troubleshooting Checklist

Problem: **"❌ No valid rows in CSV"**
- [ ] Did you paste the header row?
- [ ] Are there data rows below it?
- [ ] Save CSV as UTF-8 (not Excel binary)

Problem: **"✅ Imported but estimates still not showing"**
- [ ] Check browser console for errors (F12)
- [ ] Are loads actually missing manifest data? (0 containers?)
- [ ] Try a different route that has more data
- [ ] Refresh the page and re-import

Problem: **"Estimates seem too high/low"**
- [ ] Check the source: csv_N means N historical loads
- [ ] If N < 10, estimates may be less reliable
- [ ] Look for outliers in your historical data
- [ ] Try re-importing fresh 14-day data

## Next Steps

1. ✅ Export 2-week historical CSV
2. ✅ Import into SSP Util
3. ✅ Watch how estimates populate when VRIDs are in transit
4. ✅ Compare estimated vs actual when loads arrive
5. ✅ Refine staffing decisions using estimates
6. ✅ Re-import every 3-5 days for freshness

---

## Performance Tips

- **Fastest import**: 500-2000 rows = ~1 second
- **Large import**: 5000+ rows = ~3-5 seconds
- **Storage**: ~10KB per 100 loads in localStorage
- **Memory**: Minimal impact (cached in localStorage)

## Security Notes

- Data stays **local to your browser** (localStorage)
- **No upload** to external servers
- **Survives logout** (localStorage persists)
- **7-day expiry** (can edit manually if needed)
- **Can be cleared** anytime via browser console or storage settings
