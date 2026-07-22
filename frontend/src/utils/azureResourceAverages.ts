import type { AzureResources } from '../types'

export interface AzureServerAverage {
  name: string
  cpuAvg: number | null
  memAvg: number | null
  sampleCount: number
}

export interface AzureResourceAverages {
  servers: AzureServerAverage[]
  totalCpu: number | null
  totalMem: number | null
  samplePoints: number
  durationSec: number
}

function mean(values: number[]): number | null {
  if (!values.length) return null
  const sum = values.reduce((a, b) => a + b, 0)
  return Math.round((sum / values.length) * 10) / 10
}

/** Average CPU/Memory % per server over all samples stored for a run. */
export function computeAzureResourceAverages(
  resources: AzureResources | null | undefined,
): AzureResourceAverages {
  const empty: AzureResourceAverages = {
    servers: [],
    totalCpu: null,
    totalMem: null,
    samplePoints: 0,
    durationSec: 0,
  }
  if (!resources?.samples?.length) return empty

  const samples = resources.samples
  const names = new Set<string>()
  for (const t of resources.targets ?? []) {
    if (t.name) names.add(t.name)
  }
  for (const sample of samples) {
    Object.keys(sample.servers ?? {}).forEach((n) => names.add(n))
  }
  const serverNames = Array.from(names)

  const servers: AzureServerAverage[] = serverNames.map((name) => {
    const cpuVals: number[] = []
    const memVals: number[] = []
    for (const s of samples) {
      const m = s.servers?.[name]
      if (m?.cpu_percent != null && Number.isFinite(m.cpu_percent)) cpuVals.push(m.cpu_percent)
      if (m?.memory_percent != null && Number.isFinite(m.memory_percent)) {
        memVals.push(m.memory_percent)
      }
    }
    return {
      name,
      cpuAvg: mean(cpuVals),
      memAvg: mean(memVals),
      sampleCount: Math.max(cpuVals.length, memVals.length),
    }
  })

  const cpuAll: number[] = []
  const memAll: number[] = []
  for (const s of samples) {
    for (const name of serverNames) {
      const m = s.servers?.[name]
      if (m?.cpu_percent != null && Number.isFinite(m.cpu_percent)) cpuAll.push(m.cpu_percent)
      if (m?.memory_percent != null && Number.isFinite(m.memory_percent)) {
        memAll.push(m.memory_percent)
      }
    }
  }

  const durationSec =
    samples.length >= 2
      ? Math.max(0, Number(samples[samples.length - 1]?.t ?? 0) - Number(samples[0]?.t ?? 0))
      : samples.length === 1
        ? Number(samples[0]?.t ?? 0)
        : 0

  return {
    servers,
    totalCpu: mean(cpuAll),
    totalMem: mean(memAll),
    samplePoints: samples.length,
    durationSec,
  }
}
