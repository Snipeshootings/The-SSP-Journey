export async function fetchPulseMetrics({ facilityId, laborDate, shiftGroupId, gmFetch, sspEnqueue }) {
  const fid = String(facilityId || "").trim();
  const metricDate = String(laborDate || "").trim();
  if (!fid) throw new Error("Missing facilityId");
  if (!metricDate) throw new Error("Missing laborDate");
  if (typeof gmFetch !== "function" || typeof sspEnqueue !== "function") {
    throw new Error("gmFetch and sspEnqueue are required");
  }

  const toNum = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const divideSafe = (a, b) => {
    const x = toNum(a);
    const y = toNum(b);
    if (x == null || y == null || y <= 0) return null;
    return x / y;
  };

  let sg = String(shiftGroupId || "").trim();
  if (!sg) {
    const flowUrl = `https://flow-metrics.service.pulse.ats.amazon.dev/getFlow/${encodeURIComponent(fid)}/${encodeURIComponent(metricDate)}`;
    const flowRes = await sspEnqueue(() => gmFetch(flowUrl, { method: "GET", credentials: "include" }), 1);
    if (!flowRes.ok) throw new Error(`Pulse getFlow HTTP ${flowRes.status}`);
    const flowData = await flowRes.json();
    const shifts = flowData?.shifts || flowData?.data?.shifts || flowData?.flowShifts || [];
    const now = Date.now();
    const active = shifts.find((s) => {
      const start = Number(s?.startTimeMs || s?.startTime || 0);
      const end = Number(s?.endTimeMs || s?.endTime || 0);
      return start > 0 && end > 0 && now >= start && now < end;
    }) || shifts[0];
    sg = String(active?.shiftGroupId || active?.groupId || active?.name || "").trim();
  }
  if (!sg) throw new Error("Unable to resolve shiftGroupId");

  const payload = {
    businessSpace: "SORT_CENTER",
    businessSpaceParams: { shiftGroupId: sg },
    dataTimeInterval: 5,
    dataType: "regular",
    facilityIds: [fid],
    metricDate,
    metricGranularity: "minute",
    metricIds: ["cph", "crossdock-hc"],
  };

  const res = await sspEnqueue(() => gmFetch("https://flow-metrics.service.pulse.ats.amazon.dev/getMetricsData", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }), 1);
  if (!res.ok) throw new Error(`Pulse getMetricsData HTTP ${res.status}`);
  const data = await res.json();

  // CPH is compound (carts-processed + crossdock-hours), so compute it manually.
  const cphSeries = data?.cph?.metricsValues?.[fid]
    || data?.compound?.metricsValues?.[fid]
    || data?.metricsData?.cph?.compound?.metricsValues?.[fid]
    || [];

  let bucketCph = null;
  let cartsTotal = 0;
  let hoursTotal = 0;
  let lastTs = 0;
  for (const row of cphSeries) {
    const c = row?.compound || row;
    const ts = Number(c?.timestamp || 0);
    const sub = c?.subMetricsMap || {};
    const carts = toNum(sub["carts-processed"]);
    const hrs = toNum(sub["crossdock-hours"]);
    if (carts == null || hrs == null) continue;
    cartsTotal += carts;
    hoursTotal += hrs;
    if (ts >= lastTs) {
      lastTs = ts;
      bucketCph = divideSafe(carts, hrs);
    }
  }

  // Shift-to-date must aggregate all buckets before division.
  const shiftToDateCph = divideSafe(cartsTotal, hoursTotal);

  const hcSeries = data?.["crossdock-hc"]?.metricsValues?.[fid]
    || data?.metricsData?.["crossdock-hc"]?.metricsValues?.[fid]
    || [];
  let crossdockHeadcount = null;
  for (const row of hcSeries) {
    const ts = Number(row?.timestamp || 0);
    const val = toNum(row?.value ?? row?.metricValue ?? row?.hc);
    if (val != null && ts >= lastTs) {
      crossdockHeadcount = val;
      lastTs = ts;
    }
  }

  return {
    bucketCph: toNum(bucketCph),
    shiftToDateCph: toNum(shiftToDateCph),
    crossdockHeadcount: toNum(crossdockHeadcount),
    lastUpdated: lastTs || Date.now(),
  };
}
