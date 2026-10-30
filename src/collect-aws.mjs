import { CloudWatchClient, GetMetricDataCommand, ListMetricsCommand } from "@aws-sdk/client-cloudwatch";
import { DescribeInstancesCommand, DescribeInstanceTypesCommand, DescribeVolumesCommand, EC2Client } from "@aws-sdk/client-ec2";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { parseObservationWindow, splitUtcWindow } from "./observation-window.mjs";

const EC2_METRICS = [
  { id: "cpu_avg", name: "CPUUtilization", stat: "Average", unit: "Percent" },
  { id: "cpu_p95", name: "CPUUtilization", stat: "p95", unit: "Percent" },
  { id: "cpu_max", name: "CPUUtilization", stat: "Maximum", unit: "Percent" },
  { id: "network_in", name: "NetworkIn", stat: "Sum", unit: "Bytes" },
  { id: "network_out", name: "NetworkOut", stat: "Sum", unit: "Bytes" },
  { id: "ebs_read_bytes", name: "EBSReadBytes", stat: "Sum", unit: "Bytes" },
  { id: "ebs_write_bytes", name: "EBSWriteBytes", stat: "Sum", unit: "Bytes" },
  { id: "cpu_credit_min", name: "CPUCreditBalance", stat: "Minimum", unit: "Count" },
  { id: "cpu_surplus_max", name: "CPUSurplusCreditBalance", stat: "Maximum", unit: "Count" },
  { id: "cpu_surplus_charged", name: "CPUSurplusCreditsCharged", stat: "Sum", unit: "Count" },
  { id: "status_failed", name: "StatusCheckFailed", stat: "Maximum", unit: "Count" },
];

const EC2_MINUTE_METRICS = [
  { id: "network_in_peak", name: "NetworkIn", stat: "Sum", unit: "Bytes", period: 60 },
  { id: "network_out_peak", name: "NetworkOut", stat: "Sum", unit: "Bytes", period: 60 },
];

const GUEST_METRICS = [
  { id: "mem_used_avg", name: "mem_used_percent", stat: "Average", unit: "Percent" },
  { id: "mem_used_p95", name: "mem_used_percent", stat: "p95", unit: "Percent" },
  { id: "mem_used_max", name: "mem_used_percent", stat: "Maximum", unit: "Percent" },
  { id: "swap_used_max", name: "swap_used_percent", stat: "Maximum", unit: "Percent" },
  { id: "disk_used_max", name: "disk_used_percent", stat: "Maximum", unit: "Percent" },
];

const EBS_METRICS = [
  { key: "read_ops", name: "VolumeReadOps", stat: "Sum", unit: "Count" },
  { key: "write_ops", name: "VolumeWriteOps", stat: "Sum", unit: "Count" },
  { key: "read_bytes", name: "VolumeReadBytes", stat: "Sum", unit: "Bytes" },
  { key: "write_bytes", name: "VolumeWriteBytes", stat: "Sum", unit: "Bytes" },
  { key: "read_time", name: "VolumeTotalReadTime", stat: "Sum", unit: "Seconds" },
  { key: "write_time", name: "VolumeTotalWriteTime", stat: "Sum", unit: "Seconds" },
  { key: "queue_max", name: "VolumeQueueLength", stat: "Maximum" },
  { key: "iops_exceeded", name: "VolumeIOPSExceededCheck", stat: "Maximum" },
  { key: "throughput_exceeded", name: "VolumeThroughputExceededCheck", stat: "Maximum" },
  { key: "stalled", name: "VolumeStalledIOCheck", stat: "Maximum" },
  { key: "burst_min", name: "BurstBalance", stat: "Minimum", unit: "Percent", burstOnly: true },
];

const EBS_MINUTE_METRICS = [
  { key: "read_ops_minute", name: "VolumeReadOps", stat: "Sum", unit: "Count", period: 60 },
  { key: "write_ops_minute", name: "VolumeWriteOps", stat: "Sum", unit: "Count", period: 60 },
  { key: "read_bytes_minute", name: "VolumeReadBytes", stat: "Sum", unit: "Bytes", period: 60 },
  { key: "write_bytes_minute", name: "VolumeWriteBytes", stat: "Sum", unit: "Bytes", period: 60 },
  { key: "read_time_minute", name: "VolumeTotalReadTime", stat: "Sum", unit: "Seconds", period: 60 },
  { key: "write_time_minute", name: "VolumeTotalWriteTime", stat: "Sum", unit: "Seconds", period: 60 },
  { key: "queue_minute", name: "VolumeQueueLength", stat: "Maximum", period: 60 },
];

function utcMidnight(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 86_400_000);
}

function dateKey(date) {
  return date.toISOString().slice(0, 10);
}

function metricQuery(metric, cloudWatchMetric) {
  const metricStat = {
    Metric: cloudWatchMetric,
    Period: metric.period ?? 86400,
    Stat: metric.stat,
  };
  if (metric.unit) metricStat.Unit = metric.unit;
  return {
    Id: metric.id,
    Label: metric.id,
    ReturnData: true,
    MetricStat: metricStat,
  };
}

function ebsMetricId(volumeIndex, key) {
  return `v${volumeIndex}_${key}`;
}

function queries(instanceId, guestMetrics, volumes, peakPeriodSeconds, aggregatePeriod = 86400, includeCoverage = false) {
  const ec2Queries = [...EC2_METRICS, ...EC2_MINUTE_METRICS].map((metric) => metricQuery({ ...metric, period: metric.period ? peakPeriodSeconds : aggregatePeriod }, {
    Namespace: "AWS/EC2",
    MetricName: metric.name,
    Dimensions: [{ Name: "InstanceId", Value: instanceId }],
  }));
  const guestQueries = GUEST_METRICS.flatMap((metric) => {
    const discovered = guestMetrics.get(metric.name);
    return discovered ? [metricQuery({ ...metric, period: aggregatePeriod }, discovered)] : [];
  });
  const ebsQueries = volumes.flatMap((volume, volumeIndex) => [...EBS_METRICS, ...EBS_MINUTE_METRICS]
    .filter(({ burstOnly }) => !burstOnly || ["gp2", "st1", "sc1"].includes(volume.VolumeType))
    .map((metric) => metricQuery({ ...metric, id: ebsMetricId(volumeIndex, metric.key), period: metric.period ? peakPeriodSeconds : aggregatePeriod }, {
      Namespace: "AWS/EBS",
      MetricName: metric.name,
      Dimensions: [{ Name: "VolumeId", Value: volume.VolumeId }],
    })));
  const coverageQueries = includeCoverage ? [
    metricQuery({ id: "coverage_cpu", period: peakPeriodSeconds, stat: "Maximum" }, { Namespace: "AWS/EC2", MetricName: "CPUUtilization", Dimensions: [{ Name: "InstanceId", Value: instanceId }] }),
    metricQuery({ id: "cpu_sample_count", period: aggregatePeriod, stat: "SampleCount" }, { Namespace: "AWS/EC2", MetricName: "CPUUtilization", Dimensions: [{ Name: "InstanceId", Value: instanceId }] }),
    ...(guestMetrics.has("mem_used_percent") ? [metricQuery({ id: "coverage_memory", period: peakPeriodSeconds, stat: "Maximum" }, guestMetrics.get("mem_used_percent"))] : []),
    ...(guestMetrics.has("mem_used_percent") ? [metricQuery({ id: "memory_sample_count", period: aggregatePeriod, stat: "SampleCount" }, guestMetrics.get("mem_used_percent"))] : []),
  ] : [];
  return [...ec2Queries, ...guestQueries, ...ebsQueries, ...coverageQueries];
}

async function discoverGuestMetrics(cloudwatch, instanceId) {
  const metrics = [];
  let nextToken;
  do {
    const response = await cloudwatch.send(new ListMetricsCommand({
      Namespace: "CWAgent",
      Dimensions: [{ Name: "InstanceId", Value: instanceId }],
      NextToken: nextToken,
    }));
    metrics.push(...(response.Metrics ?? []));
    nextToken = response.NextToken;
  } while (nextToken);

  const selected = new Map();
  for (const metric of metrics) {
    if (!GUEST_METRICS.some(({ name }) => name === metric.MetricName)) continue;
    if (metric.MetricName === "disk_used_percent") {
      const path = metric.Dimensions?.find(({ Name }) => Name === "path")?.Value;
      if (path !== "/") continue;
    }
    if (!selected.has(metric.MetricName)) selected.set(metric.MetricName, metric);
  }
  return selected;
}

export function createAwsClients(region) {
  return {
    cloudwatch: new CloudWatchClient({ region }),
    ec2: new EC2Client({ region }),
    sts: new STSClient({ region }),
  };
}

export async function collectAwsHistory(hostAudit, options = {}) {
  const instanceId = hostAudit?.cloud?.instance_id;
  const region = options.region ?? hostAudit?.cloud?.region;
  const now = options.now ?? new Date();
  const explicitWindow = options.window ? parseObservationWindow(options.window.start, options.window.end, { now, maxDays: 90 }) : null;
  const days = explicitWindow?.days ?? Number(options.days ?? 14);
  if (!instanceId || !region) throw new Error("host audit 缺少 AWS instance_id 或 region");
  if (!explicitWindow && (!Number.isInteger(days) || days < 1 || days > 90)) throw new Error("days 必須是 1～90 的整數");

  const clients = options.clients ?? createAwsClients(region);
  const endTime = explicitWindow ? new Date(explicitWindow.end) : utcMidnight(now);
  const startTime = explicitWindow ? new Date(explicitWindow.start) : addDays(endTime, -days);
  const retentionPeriod = now-startTime >= 63*86400000 ? 3600 : now-startTime >= 15*86400000 ? 300 : 60;
  if (explicitWindow && (startTime.getTime() % (retentionPeriod*1000) || endTime.getTime() % (retentionPeriod*1000))) throw new Error(`CloudWatch 保存粒度需要起訖對齊 ${retentionPeriod} 秒；不會自動擴大區間`);
  const segments = splitUtcWindow({ start: startTime.toISOString(), end: endTime.toISOString() });

  const [identity, described] = await Promise.all([
    clients.sts.send(new GetCallerIdentityCommand({})),
    clients.ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] })),
  ]);
  const instance = described.Reservations?.flatMap(({ Instances = [] }) => Instances)[0];
  if (!instance) throw new Error(`AWS 找不到 instance: ${instanceId}`);
  const instanceTypeName = instance.InstanceType ?? hostAudit.cloud.instance_type;
  const comparedInstanceTypes = [...new Set([instanceTypeName, "t3.medium"].filter(Boolean))];
  const typeResult = await clients.ec2.send(new DescribeInstanceTypesCommand({ InstanceTypes: comparedInstanceTypes }));
  const instanceType = typeResult.InstanceTypes?.find(({ InstanceType }) => InstanceType === instanceTypeName) ?? typeResult.InstanceTypes?.[0];
  const targetInstanceType = typeResult.InstanceTypes?.find(({ InstanceType }) => InstanceType === "t3.medium");
  const peakPeriodSeconds = Math.max(retentionPeriod, instance.Monitoring?.State === "enabled" ? 60 : 300);
  if (explicitWindow && (startTime.getTime() % (peakPeriodSeconds*1000) || endTime.getTime() % (peakPeriodSeconds*1000))) throw new Error(`此主機指標粒度需要起訖對齊 ${peakPeriodSeconds} 秒；不會自動擴大區間`);
  const volumeIds = (instance.BlockDeviceMappings ?? []).map(({ Ebs }) => Ebs?.VolumeId).filter(Boolean);
  const volumeResult = volumeIds.length
    ? await clients.ec2.send(new DescribeVolumesCommand({ VolumeIds: volumeIds }))
    : { Volumes: [] };
  const volumes = volumeIds.map((volumeId) => volumeResult.Volumes?.find(({ VolumeId }) => VolumeId === volumeId)).filter(Boolean);
  const guestMetrics = await discoverGuestMetrics(clients.cloudwatch, instanceId);
  const requestedMetrics = [
    ...EC2_METRICS,
    ...EC2_MINUTE_METRICS,
    ...GUEST_METRICS.filter(({ name }) => guestMetrics.has(name)),
  ];

  const metricResults = [];
  for (const segment of explicitWindow ? segments : [{ start: startTime, end: endTime, seconds: 86400 }]) {
    let nextToken;
    const metricQueries = queries(instanceId, guestMetrics, volumes, peakPeriodSeconds, segment.seconds, true);
    const periods = new Map(metricQueries.map(q => [q.Id, q.MetricStat.Period]));
    do {
    const response = await clients.cloudwatch.send(new GetMetricDataCommand({
      StartTime: segment.start,
      EndTime: segment.end,
      MetricDataQueries: metricQueries,
      ScanBy: "TimestampAscending",
      NextToken: nextToken,
    }));
    for (const result of response.MetricDataResults ?? []) {
      const filtered = { ...result, Timestamps: [], Values: [] };
      for (let i=0;i<(result.Timestamps?.length??0);i++) {
        const timestamp = result.Timestamps[i];
        const period = periods.get(result.Id);
        if (period && timestamp >= segment.start && timestamp.getTime()+period*1000 <= segment.end.getTime() && Number.isFinite(result.Values?.[i])) {
          filtered.Timestamps.push(timestamp); filtered.Values.push(result.Values[i]);
        }
      }
      metricResults.push(filtered);
    }
    nextToken = response.NextToken;
    } while (nextToken);
  }

  const dailyByDate = new Map();
  for (const segment of segments) {
    dailyByDate.set(segment.date, { date: segment.date, ...(explicitWindow ? { window_start: segment.start.toISOString(), window_end: segment.end.toISOString() } : {}), metrics: {} });
  }
  const statuses = {};
  const ebsResultById = new Map();
  for (const result of metricResults) {
    statuses[result.Id] = result.StatusCode ?? "Unknown";
    if (result.Id.startsWith("coverage_")) continue;
    if (/^v\d+_/.test(result.Id)) {
      const previous = ebsResultById.get(result.Id);
      ebsResultById.set(result.Id, previous ? {
        ...result,
        Timestamps: [...(previous.Timestamps ?? []), ...(result.Timestamps ?? [])],
        Values: [...(previous.Values ?? []), ...(result.Values ?? [])],
      } : result);
      continue;
    }
    for (let index = 0; index < (result.Timestamps?.length ?? 0); index += 1) {
      const day = dailyByDate.get(dateKey(result.Timestamps[index]));
      if (day) {
        const value = result.Values?.[index] ?? null;
        if (result.Id.endsWith("_peak") && Number.isFinite(value)) {
          day.metrics[result.Id] = Math.max(day.metrics[result.Id] ?? 0, value);
        } else {
          day.metrics[result.Id] = value;
        }
      }
    }
  }

  const daily = [...dailyByDate.values()];
  for (const { metrics } of daily) {
    if (Number.isFinite(metrics.network_in_peak)) metrics.network_in_peak_mib_s = metrics.network_in_peak / peakPeriodSeconds / 1024 / 1024;
    if (Number.isFinite(metrics.network_out_peak)) metrics.network_out_peak_mib_s = metrics.network_out_peak / peakPeriodSeconds / 1024 / 1024;
  }
  const coverage = Object.fromEntries(requestedMetrics.map(({ id }) => [id, daily.filter(({ metrics }) => metrics[id] !== undefined).length / days]));
  // Both daily and explicit windows must measure source slots, not dates with data.
  const slotCoverage = (id, period) => {
    const times = new Set(metricResults.filter(r=>r.Id===id).flatMap(r=>r.Timestamps.map(t=>Math.floor((t.getTime()-startTime.getTime())/(period*1000)))));
    return Math.min(1, times.size * period / ((endTime-startTime)/1000));
  };
  const aggregateCoverage = (id) => segments.reduce((sum, segment) => sum + (metricResults.some(r=>r.Id===id && r.Timestamps.some(t=>t.getTime()===segment.start.getTime())) ? segment.seconds : 0),0)/((endTime-startTime)/1000);
  for (const { id, period } of requestedMetrics) {
    if (period) coverage[id] = slotCoverage(id, peakPeriodSeconds);
    else if (explicitWindow) coverage[id] = aggregateCoverage(id);
    if (id.startsWith("cpu_") && ["cpu_avg","cpu_p95","cpu_max"].includes(id)) coverage[id] = Math.min(coverage[id],slotCoverage("coverage_cpu",peakPeriodSeconds));
    if (id.startsWith("mem_used_")) coverage[id] = Math.min(coverage[id],slotCoverage("coverage_memory",peakPeriodSeconds));
  }
  const name = instance.Tags?.find(({ Key }) => Key === "Name")?.Value ?? null;
  const ebsDaily = daily.map(({ date, window_start, window_end }) => ({
    date,
    ...(explicitWindow ? { window_start, window_end } : {}),
    volumes: Object.fromEntries(volumes.map((volume, volumeIndex) => {
      const raw = Object.fromEntries(EBS_METRICS.map(({ key }) => {
        const result = ebsResultById.get(ebsMetricId(volumeIndex, key));
        if (!result) return [key, null];
        const index = result.Timestamps?.findIndex((timestamp) => dateKey(timestamp) === date) ?? -1;
        return [key, index >= 0 ? result.Values?.[index] ?? null : null];
      }));
      const minute = Object.fromEntries(EBS_MINUTE_METRICS.map(({ key }) => {
        const result = ebsResultById.get(ebsMetricId(volumeIndex, key));
        const points = (result?.Timestamps ?? []).flatMap((timestamp, index) => dateKey(timestamp) === date
          ? [{ timestamp: timestamp.getTime(), value: result.Values?.[index] }]
          : []);
        return [key, points];
      }));
      const minuteMap = (key) => new Map((minute[key] ?? []).filter(({ value }) => Number.isFinite(value)).map(({ timestamp, value }) => [timestamp, value]));
      const maximum = (items) => items.length ? Math.max(...items) : null;
      const readOps = minuteMap("read_ops_minute");
      const writeOps = minuteMap("write_ops_minute");
      const readTime = minuteMap("read_time_minute");
      const writeTime = minuteMap("write_time_minute");
      const readLatencies = [...readOps].flatMap(([timestamp, ops]) => ops > 0 && readTime.has(timestamp) ? [readTime.get(timestamp) / ops * 1000] : []);
      const writeLatencies = [...writeOps].flatMap(([timestamp, ops]) => ops > 0 && writeTime.has(timestamp) ? [writeTime.get(timestamp) / ops * 1000] : []);
      return [volume.VolumeId, {
        read_ops: raw.read_ops,
        write_ops: raw.write_ops,
        read_bytes: raw.read_bytes,
        write_bytes: raw.write_bytes,
        read_latency_ms: raw.read_ops > 0 && Number.isFinite(raw.read_time) ? raw.read_time / raw.read_ops * 1000 : null,
        write_latency_ms: raw.write_ops > 0 && Number.isFinite(raw.write_time) ? raw.write_time / raw.write_ops * 1000 : null,
        queue_max: raw.queue_max,
        iops_exceeded: raw.iops_exceeded,
        throughput_exceeded: raw.throughput_exceeded,
        stalled: raw.stalled,
        burst_balance_min_percent: raw.burst_min,
        read_iops_peak: maximum([...readOps.values()].map((value) => value / peakPeriodSeconds)),
        write_iops_peak: maximum([...writeOps.values()].map((value) => value / peakPeriodSeconds)),
        read_throughput_mib_s_peak: maximum((minute.read_bytes_minute ?? []).map(({ value }) => value / peakPeriodSeconds / 1024 / 1024)),
        write_throughput_mib_s_peak: maximum((minute.write_bytes_minute ?? []).map(({ value }) => value / peakPeriodSeconds / 1024 / 1024)),
        queue_minute_peak: maximum((minute.queue_minute ?? []).map(({ value }) => value)),
        read_latency_minute_peak_ms: maximum(readLatencies),
        write_latency_minute_peak_ms: maximum(writeLatencies),
      }];
    })),
  }));
  const ebsCoverage = Object.fromEntries(volumes.map((volume, volumeIndex) => [volume.VolumeId, Object.fromEntries([...EBS_METRICS, ...EBS_MINUTE_METRICS]
    .filter(({ burstOnly }) => !burstOnly || ["gp2", "st1", "sc1"].includes(volume.VolumeType))
    .map(({ key, period }) => {
      if (period) return [key, slotCoverage(ebsMetricId(volumeIndex,key),peakPeriodSeconds)];
      if (explicitWindow) return [key, aggregateCoverage(ebsMetricId(volumeIndex,key))];
      const result = ebsResultById.get(ebsMetricId(volumeIndex, key));
      const covered = new Set((result?.Timestamps ?? []).map(dateKey));
      return [key, daily.filter(({ date }) => covered.has(date)).length / days];
    }))]));
  const ebsMetricAvailability = Object.fromEntries(volumes.map((volume, volumeIndex) => [volume.VolumeId, {
    iops_exceeded: (ebsResultById.get(ebsMetricId(volumeIndex, "iops_exceeded"))?.Timestamps?.length ?? 0) > 0 ? "available" : "not_available",
    throughput_exceeded: (ebsResultById.get(ebsMetricId(volumeIndex, "throughput_exceeded"))?.Timestamps?.length ?? 0) > 0 ? "available" : "not_available",
  }]));

  return {
    schema_version: "1.0",
    type: "aws_cloudwatch_history",
    collected_at: now.toISOString(),
    evaluation_stage: days >= 30 ? "formal_30d" : days >= 14 ? "preliminary_14d" : "collecting",
    window: { days, start: startTime.toISOString(), end: endTime.toISOString(), timezone: "UTC", completed_days_only: explicitWindow?.completed_days_only ?? true, ...(explicitWindow ? { explicit: true, boundary: "start_inclusive_end_exclusive" } : {}) },
    coverage_basis: "unique_period_slots_for_peaks_and_cpu_memory; daily_or_duration_weighted_segments_for_other_aggregates",
    source: { provider: "aws", account_id: identity.Account ?? null, caller_arn: identity.Arn ?? null, region },
    instance: {
      instance_id: instanceId,
      name,
      instance_type: instanceTypeName ?? null,
      state: instance.State?.Name ?? null,
      architecture: instance.Architecture ?? null,
      availability_zone: instance.Placement?.AvailabilityZone ?? null,
      vcpus: instanceType?.VCpuInfo?.DefaultVCpus ?? null,
      memory_mib: instanceType?.MemoryInfo?.SizeInMiB ?? null,
      network_performance: instanceType?.NetworkInfo?.NetworkPerformance ?? null,
    },
    comparison_instance_types: {
      "t3.medium": targetInstanceType ? {
        vcpus: targetInstanceType.VCpuInfo?.DefaultVCpus ?? null,
        memory_mib: targetInstanceType.MemoryInfo?.SizeInMiB ?? null,
        network_performance: targetInstanceType.NetworkInfo?.NetworkPerformance ?? null,
        baseline_bandwidth_gbps: targetInstanceType.NetworkInfo?.NetworkCards?.[0]?.BaselineBandwidthInGbps ?? null,
        peak_bandwidth_gbps: targetInstanceType.NetworkInfo?.NetworkCards?.[0]?.PeakBandwidthInGbps ?? null,
      } : null,
    },
    peak_metric_period_seconds: peakPeriodSeconds,
    metric_status: statuses,
    coverage,
    daily,
    guest_metrics: {
      namespace: "CWAgent",
      discovered: [...guestMetrics.keys()].sort(),
    },
    ebs: {
      volumes: volumes.map((volume) => ({
        volume_id: volume.VolumeId,
        type: volume.VolumeType ?? null,
        size_gib: volume.Size ?? null,
        provisioned_iops: volume.Iops ?? null,
        provisioned_throughput_mib_s: volume.Throughput ?? null,
        encrypted: volume.Encrypted ?? null,
      })),
      coverage: ebsCoverage,
      metric_availability: ebsMetricAvailability,
      daily: ebsDaily,
    },
    limitations: [
      guestMetrics.has("mem_used_percent")
        ? "CWAgent guest metrics 已接入；coverage 未達觀測期門檻前仍不可據此降規。"
        : "未找到此 instance 的 CWAgent RAM 指標；AWS/EC2 預設指標不包含 guest RAM。",
      "EBS exceeded-check 與 latency 指標依 volume type、Nitro 與 AWS 發布條件可能不存在；缺值不等於零。",
      explicitWindow ? "指定區間以 UTC 日切段，首尾可為部分日；p95 由 CloudWatch 對每段直接計算，不平均分鐘 p95。硬體 inventory 是查詢當下狀態，不代表過去配置。" : "此輸出只讀取完整 UTC 日；當天未完成資料會留給下一次 summary。",
      "14 天只供初評；正式 downsize_candidate 至少需要 30 天且涵蓋業務尖峰。",
    ],
  };
}
