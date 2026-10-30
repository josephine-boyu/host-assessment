// No built-in price or capacity table: API inventory / reviewed policy is evidence.
export function compareTargetCapacity(history, target) {
  const missing=[], reasons=[], evidence={};
  const required=["memory_mib","vcpus","cpu_baseline_percent","network_baseline_mib_s","ebs_baseline_iops","ebs_baseline_mib_s"];
  for(const key of required) if (!Number.isFinite(target?.[key]) || target[key]<=0) missing.push(`target_${key}_unknown`);
  if (target?.cpu_baseline_percent > 100 || !Number.isInteger(target?.vcpus)) missing.push("target_cpu_specification_invalid");
  if (!target?.instance_type || target?.compatibility_verified !== true) missing.push("target_compatibility_unverified");
  if (!target?.evidence_source || !Number.isFinite(Date.parse(target?.verified_at))) missing.push("target_specification_source_missing");
  const rows=history.daily?.map(d=>d.metrics)??[];
  const metrics=["cpu_avg","cpu_max","network_in_peak_mib_s","network_out_peak_mib_s","cpu_credit_min","cpu_surplus_charged"];
  for(const key of metrics) {
    const coverageKey=key.replace("_mib_s","");
    if (!(history.coverage?.[coverageKey]>=0.9) || !rows.length || rows.some(r=>!Number.isFinite(r?.[key]) || r[key]<0)) missing.push(`capacity_${key}_missing`);
  }
  const max=k=>Math.max(0,...rows.map(r=>Number.isFinite(r?.[k])?r[k]:0));
  if (!Number.isFinite(history.instance?.vcpus) || history.instance.vcpus<=0) missing.push("source_vcpus_unknown");
  const projectedCpu=max("cpu_avg") * history.instance?.vcpus / target?.vcpus;
  evidence.target_cpu_daily_average_peak_percent=Number.isFinite(projectedCpu)?projectedCpu:null;
  if (projectedCpu >= target?.cpu_baseline_percent * 0.8) reasons.push("target_cpu_baseline_headroom_low");
  if (max("cpu_max") * history.instance?.vcpus / target?.vcpus > 80) reasons.push("target_cpu_peak_headroom_low");
  if (max("cpu_surplus_charged")>0) reasons.push("source_cpu_surplus_charged");
  if (max("network_in_peak_mib_s")+max("network_out_peak_mib_s")>=target?.network_baseline_mib_s*0.8) reasons.push("target_network_headroom_low");
  let iops=0,throughput=0;
  for(const volume of history.ebs?.volumes??[]) {
    const samples=(history.ebs?.daily??[]).map(d=>d.volumes?.[volume.volume_id]);
    const keys=["read_iops_peak","write_iops_peak","read_throughput_mib_s_peak","write_throughput_mib_s_peak"];
    if(!samples.length || samples.some(s=>keys.some(k=>!Number.isFinite(s?.[k]) || s[k]<0))) missing.push(`target_ebs_peak_evidence_missing:${volume.volume_id}`);
    const peak=k=>Math.max(0,...samples.map(s=>Number.isFinite(s?.[k])?s[k]:0));
    iops+=peak(keys[0])+peak(keys[1]); throughput+=peak(keys[2])+peak(keys[3]);
  }
  evidence.aggregate_ebs_iops_peak_upper_bound=iops;
  evidence.aggregate_ebs_mib_s_peak_upper_bound=throughput;
  if(iops>=target?.ebs_baseline_iops*0.8 || throughput>=target?.ebs_baseline_mib_s*0.8) reasons.push("target_instance_ebs_headroom_low");
  return {missing,reasons,evidence};
}
