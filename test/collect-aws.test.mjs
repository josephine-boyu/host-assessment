import assert from "node:assert/strict";
import test from "node:test";
import { collectAwsHistory } from "../src/collect-aws.mjs";

const hostAudit = {
  cloud: { provider: "aws", instance_id: "i-example", instance_type: "t3.small", region: "ap-southeast-1" },
};

function fakeClients() {
  let metricPage = 0;
  return {
    sts: { send: async () => ({ Account: "123456789012", Arn: "arn:aws:iam::123456789012:role/ReadOnly" }) },
    ec2: {
      send: async (command) => {
        if (command.constructor.name === "DescribeInstancesCommand") return { Reservations: [{ Instances: [{ InstanceId: "i-example", InstanceType: "t3.small", Architecture: "x86_64", State: { Name: "running" }, Monitoring: { State: "enabled" }, Placement: { AvailabilityZone: "ap-southeast-1a" }, Tags: [{ Key: "Name", Value: "example" }], BlockDeviceMappings: [{ DeviceName: "/dev/xvda", Ebs: { VolumeId: "vol-example" } }] }] }] };
        if (command.constructor.name === "DescribeVolumesCommand") return { Volumes: [{ VolumeId: "vol-example", VolumeType: "gp3", Size: 20, Iops: 3000, Throughput: 125, Encrypted: true }] };
        return { InstanceTypes: [{ InstanceType: "t3.small", VCpuInfo: { DefaultVCpus: 2 }, MemoryInfo: { SizeInMiB: 2048 } }] };
      },
    },
    cloudwatch: {
      send: async (command) => {
        if (command.constructor.name === "ListMetricsCommand") return {
          Metrics: [
            { Namespace: "CWAgent", MetricName: "mem_used_percent", Dimensions: [{ Name: "InstanceId", Value: "i-example" }] },
            { Namespace: "CWAgent", MetricName: "swap_used_percent", Dimensions: [{ Name: "InstanceId", Value: "i-example" }] },
            { Namespace: "CWAgent", MetricName: "disk_used_percent", Dimensions: [{ Name: "InstanceId", Value: "i-example" }, { Name: "path", Value: "/" }, { Name: "fstype", Value: "xfs" }] },
            { Namespace: "CWAgent", MetricName: "disk_used_percent", Dimensions: [{ Name: "InstanceId", Value: "i-example" }, { Name: "path", Value: "/data" }] },
          ],
        };
        metricPage += 1;
        if (metricPage === 1) return {
          NextToken: "page-2",
          MetricDataResults: [
            { Id: "cpu_avg", StatusCode: "Complete", Timestamps: [new Date("2026-08-19T00:00:00Z")], Values: [12.5] },
            { Id: "mem_used_max", StatusCode: "Complete", Timestamps: [new Date("2026-08-19T00:00:00Z")], Values: [73] },
            { Id: "v0_read_ops", StatusCode: "Complete", Timestamps: [new Date("2026-08-19T00:00:00Z")], Values: [100] },
            { Id: "v0_read_time", StatusCode: "Complete", Timestamps: [new Date("2026-08-19T00:00:00Z")], Values: [0.2] },
            { Id: "v0_queue_max", StatusCode: "Complete", Timestamps: [new Date("2026-08-19T00:00:00Z")], Values: [1.5] },
            { Id: "v0_iops_exceeded", StatusCode: "Complete", Timestamps: [new Date("2026-08-19T00:00:00Z")], Values: [0] },
            { Id: "network_in_peak", StatusCode: "Complete", Timestamps: [new Date("2026-08-19T00:01:00Z"), new Date("2026-08-19T00:02:00Z")], Values: [600, 1200] },
            { Id: "v0_read_ops_minute", StatusCode: "Complete", Timestamps: [new Date("2026-08-19T00:01:00Z")], Values: [600] },
            { Id: "v0_read_bytes_minute", StatusCode: "Complete", Timestamps: [new Date("2026-08-19T00:01:00Z")], Values: [62914560] },
            { Id: "v0_read_time_minute", StatusCode: "Complete", Timestamps: [new Date("2026-08-19T00:01:00Z")], Values: [0.6] },
            { Id: "v0_queue_minute", StatusCode: "Complete", Timestamps: [new Date("2026-08-19T00:01:00Z")], Values: [0.25] },
          ],
        };
        return {
          MetricDataResults: [{ Id: "cpu_max", StatusCode: "Complete", Timestamps: [new Date("2026-08-19T00:00:00Z")], Values: [44] }],
        };
      },
    },
  };
}

test("collects paginated AWS metrics into 14-day daily summaries", async () => {
  const result = await collectAwsHistory(hostAudit, { clients: fakeClients(), days: 14, now: new Date("2026-09-02T12:00:00Z") });
  assert.equal(result.evaluation_stage, "preliminary_14d");
  assert.equal(result.window.start, "2026-08-19T00:00:00.000Z");
  assert.equal(result.window.end, "2026-09-02T00:00:00.000Z");
  assert.equal(result.daily.length, 14);
  assert.deepEqual(result.daily[0].metrics, { cpu_avg: 12.5, mem_used_max: 73, network_in_peak: 1200, network_in_peak_mib_s: 1200 / 60 / 1024 / 1024, cpu_max: 44 });
  assert.equal(result.instance.vcpus, 2);
  assert.equal(result.instance.memory_mib, 2048);
  assert.equal(result.coverage.cpu_avg, 0); // No source-slot evidence returned.
  assert.equal(result.coverage.mem_used_max, 0);
  assert.deepEqual(result.guest_metrics.discovered, ["disk_used_percent", "mem_used_percent", "swap_used_percent"]);
  assert.deepEqual(result.ebs.volumes[0], { volume_id: "vol-example", type: "gp3", size_gib: 20, provisioned_iops: 3000, provisioned_throughput_mib_s: 125, encrypted: true });
  assert.equal(result.ebs.daily[0].volumes["vol-example"].read_latency_ms, 2);
  assert.equal(result.ebs.daily[0].volumes["vol-example"].queue_max, 1.5);
  assert.equal(result.ebs.coverage["vol-example"].read_ops, 1 / 14);
  assert.equal(result.daily[0].metrics.network_in_peak, 1200);
  assert.equal(result.peak_metric_period_seconds, 60);
  assert.equal(result.ebs.daily[0].volumes["vol-example"].read_iops_peak, 10);
  assert.equal(result.ebs.daily[0].volumes["vol-example"].read_throughput_mib_s_peak, 1);
  assert.equal(result.ebs.daily[0].volumes["vol-example"].read_latency_minute_peak_ms, 1);
  assert.equal(result.ebs.metric_availability["vol-example"].throughput_exceeded, "not_available");
});

test("marks 30 days as the formal evaluation stage", async () => {
  const clients = fakeClients();
  const result = await collectAwsHistory(hostAudit, { clients, days: 30, now: new Date("2026-09-02T12:00:00Z") });
  assert.equal(result.evaluation_stage, "formal_30d");
});

test("rejects missing identity and invalid windows before AWS calls", async () => {
  await assert.rejects(() => collectAwsHistory({ cloud: {} }, { days: 14 }), /instance_id/);
  await assert.rejects(() => collectAwsHistory(hostAudit, { days: 0 }), /1～90/);
});

test("queries exact partial-day aggregates and excludes out-of-window data",async()=>{
  const clients=fakeClients();const original=clients.cloudwatch.send;
  const calls=[];
  clients.cloudwatch.send=async command=>{
    if(command.constructor.name!=="GetMetricDataCommand") return original(command);
    const {StartTime:start,EndTime:end,MetricDataQueries:queries}=command.input;
    calls.push(command.input);
    return {MetricDataResults:queries.map(q=>{
      const timestamps=[],values=[];
      for(let t=start.getTime();t<end.getTime();t+=q.MetricStat.Period*1000) {timestamps.push(new Date(t));values.push(q.Id==="cpu_avg"?12:1);}
      return {Id:q.Id,StatusCode:"Complete",Timestamps:[new Date(start-60000),...timestamps,end],Values:[999,...values,999]};
    })};
  };
  const result=await collectAwsHistory(hostAudit,{clients,now:new Date("2026-09-02T00:00:00Z"),window:{start:"2026-08-31T23:00:00Z",end:"2026-09-01T01:00:00Z"}});
  assert.equal(calls.length,2);assert.equal(result.daily.length,2);assert.equal(result.window.days,2/24);
  assert.equal(result.window.completed_days_only,false);assert.equal(result.window.explicit,true);
  for(const call of calls) assert.equal(call.MetricDataQueries.find(q=>q.Id==="cpu_p95").MetricStat.Period,3600);
  assert.equal(result.coverage.cpu_avg,1);assert.equal(result.coverage.network_in_peak,1);
  assert.equal(result.ebs.coverage["vol-example"].read_ops_minute,1);
  assert.ok(result.daily.every(day=>day.metrics.cpu_avg===12 && day.metrics.network_in_peak===1));
  assert.deepEqual(result.ebs.daily.map(({date,window_start,window_end})=>({date,window_start,window_end})),
    result.daily.map(({date,window_start,window_end})=>({date,window_start,window_end})));
});
test("refuses unsupported retention alignment without silently expanding a window",async()=>{
  let touched=false;
  const clients={sts:{send:()=>{touched=true;}},ec2:{send:()=>{touched=true;}}};
  await assert.rejects(collectAwsHistory(hostAudit,{clients,now:new Date("2026-10-30T00:00:00Z"),window:{start:"2026-10-01T00:01:00Z",end:"2026-10-02T00:01:00Z"}}),/300 秒/);
  assert.equal(touched,false);
});

test("daily coverage rejects one point per day and deduplicates source slots", async () => {
  const clients = fakeClients();
  const original = clients.cloudwatch.send;
  clients.cloudwatch.send = async command => {
    if (command.constructor.name !== "GetMetricDataCommand") return original(command);
    const { StartTime: start, EndTime: end, MetricDataQueries: queries } = command.input;
    assert.ok(queries.some(q => q.Id === "coverage_cpu"));
    assert.ok(queries.some(q => q.Id === "coverage_memory"));
    return { MetricDataResults: queries.map(q => {
      const timestamps = [];
      for (let t = +start; t < +end; t += 86400000) timestamps.push(new Date(t), new Date(t));
      return { Id: q.Id, StatusCode: "Complete", Timestamps: [new Date(+start-60000), ...timestamps, end], Values: Array(timestamps.length+2).fill(1) };
    }) };
  };
  const result = await collectAwsHistory(hostAudit, { clients, days: 14, now: new Date("2026-09-02T12:00:00Z") });
  for (const key of ["cpu_avg", "cpu_p95", "cpu_max", "mem_used_avg", "mem_used_p95", "mem_used_max", "network_in_peak", "network_out_peak"]) {
    assert.equal(result.coverage[key], 1/1440, key);
  }
  assert.equal(result.ebs.coverage["vol-example"].read_ops_minute, 1/1440);
  assert.equal(result.daily.length, 14);
});

test("daily complete source slots reach full coverage at retained five-minute resolution", async () => {
  const clients = fakeClients();
  const original = clients.cloudwatch.send;
  clients.cloudwatch.send = async command => {
    if (command.constructor.name !== "GetMetricDataCommand") return original(command);
    const { StartTime: start, EndTime: end, MetricDataQueries: queries } = command.input;
    return { MetricDataResults: queries.map(q => {
      const timestamps = [];
      for (let t=+start; t<+end; t+=q.MetricStat.Period*1000) timestamps.push(new Date(t));
      return { Id:q.Id, StatusCode:"Complete", Timestamps:timestamps, Values:timestamps.map(()=>1) };
    }) };
  };
  const result = await collectAwsHistory(hostAudit, {clients, days:30, now:new Date("2026-09-02T12:00:00Z")});
  assert.equal(result.peak_metric_period_seconds,300);
  assert.equal(result.coverage.cpu_avg,1);
  assert.equal(result.coverage.mem_used_max,1);
  assert.equal(result.coverage.network_in_peak,1);
  assert.equal(result.ebs.coverage["vol-example"].read_ops_minute,1);
});
