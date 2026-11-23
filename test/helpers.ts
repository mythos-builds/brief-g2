import { readFileSync } from 'node:fs'
import type { Dataset } from '../src/logic/types.ts'

export function loadDataset(): Dataset {
  return JSON.parse(readFileSync(new URL('../src/data/dataset.json', import.meta.url), 'utf8')) as Dataset
}
