/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { GridPoint, AirQualityData, MergedGridData, TimeStep } from '../types';

// Constants for Tianjin bounds
const TIANJIN_CENTER = { lng: 117.2, lat: 39.12 };
const GRID_COUNT = 2500; // Reduced for demo performance, scaled up in production

export const getColor = (v: number): [number, number, number, number] => {
  if (v < 35) return [0, 228, 0, 160];       // Good
  if (v < 75) return [255, 255, 0, 170];     // Moderate
  if (v < 115) return [255, 126, 0, 180];    // Unhealthy for Sensitive
  if (v < 150) return [255, 0, 0, 190];      // Unhealthy
  if (v < 250) return [153, 0, 76, 200];     // Very Unhealthy
  return [126, 0, 35, 220];                  // Hazardous
};

class DataService {
  private staticGridMap: Record<string, any> = {};
  private dynamicTimeline: Record<string, any[]> = {};
  private currentTimestamps: string[] = [];
  private isLoaded: boolean = false;

  private cache: Record<string, MergedGridData[]> = {};

  constructor() {
    this.init();
  }

  private async init() {
    try {
      const [tsRes, staticRes] = await Promise.all([
        fetch('/api/timestamps'),
        fetch('/api/static-grids')
      ]);

      if (tsRes.ok && staticRes.ok) {
        const [timestamps, staticGrids] = await Promise.all([
          tsRes.json(),
          staticRes.json()
        ]);

        if (Array.isArray(timestamps) && timestamps.length > 0) {
          this.currentTimestamps = timestamps;
          
          if (Array.isArray(staticGrids)) {
            this.staticGridMap = {};
            staticGrids.forEach(g => {
              this.staticGridMap[g.id] = {
                lng: Number(g.lng),
                lat: Number(g.lat),
                nearest_meteo_id: g.nearest_meteo_id || "N/A",
                cnt_industrial: Number(g.cnt_industrial || 0),
                cnt_commercial: Number(g.cnt_commercial || 0),
                cnt_nature: Number(g.cnt_nature || 0),
                cnt_transport: Number(g.cnt_transport || 0),
                cnt_catering: Number(g.cnt_catering || 0)
              };
            });
            console.log(`[DataService] Initialized with ${staticGrids.length} static grids mapped.`);
          }
          
          this.isLoaded = true;
          console.log("Connected to API: Timeline and Static Attributes indexed.");
          return;
        }
      }
    } catch (e) {
      console.warn("API not responding, using fallback mode", e);
    }
    this.generateMockStaticData();
    this.generateTimeSteps();
  }

  async getMergedData(timestamp: string): Promise<MergedGridData[]> {
    // 1. 优先检查本地缓存，避免重复请求同一秒数据
    if (this.cache[timestamp]) return this.cache[timestamp];

    // Wait for loaded
    if (!this.isLoaded) {
      await this.getTimestampsAsync();
    }

    try {
      // 2. 只请求当前时间点的数据（通常只有几百KB）
      const response = await fetch(`/api/data?time=${encodeURIComponent(timestamp)}`);
      if (response.ok) {
        const rawData = await response.json();
        console.log(`[DataService] Fetched data size: ${rawData?.length} records for ${timestamp}`);
        if (Array.isArray(rawData) && rawData.length > 0) {
          const merged: MergedGridData[] = [];
          
          for (let i = 0; i < rawData.length; i++) {
            const d = rawData[i];
            const staticItem = this.staticGridMap[d.id];
            if (!staticItem) continue;

            const val = d.v !== undefined && d.v !== null ? Number(d.v) : 0;
            merged.push({
              grid_id: d.id,
              lng: staticItem.lng,
              lat: staticItem.lat,
              v: val,
              nearest_meteo_id: staticItem.nearest_meteo_id,
              cnt_industrial: staticItem.cnt_industrial,
              cnt_commercial: staticItem.cnt_commercial,
              cnt_nature: staticItem.cnt_nature,
              cnt_transport: staticItem.cnt_transport,
              cnt_catering: staticItem.cnt_catering,
              color: getColor(val)
            });
          }
          
          console.log(`[DataService] Successfully parsed and merged ${merged.length} columns.`);
          
          // 3. 缓存结果，防止频繁滑动导致网络压力
          this.cache[timestamp] = merged;
          
          // 如果缓存太大，清理一下防止浏览器再次崩溃
          const keys = Object.keys(this.cache);
          if (keys.length > 50) delete this.cache[keys[0]]; 

          return merged;
        } else {
          console.warn(`[DataService] Raw data for ${timestamp} is empty or not an array`);
        }
      } else {
        console.error(`[DataService] Response failed: status ${response.status}`);
      }
    } catch (err) {
      console.error("Fetch data error:", err);
    }

    // Fallback if local timeline mock data exists
    if (this.dynamicTimeline[timestamp]) {
      const pData = this.dynamicTimeline[timestamp];
      return pData.map(d => {
        const s = this.staticGridMap[d.id] || { lng: 117.365, lat: 39.26 };
        return {
          grid_id: d.id,
          lng: s.lng,
          lat: s.lat,
          v: d.v,
          nearest_meteo_id: "Fallback",
          cnt_industrial: 0,
          cnt_commercial: 0,
          cnt_nature: 0,
          cnt_transport: 0,
          cnt_catering: 0,
          color: getColor(d.v)
        };
      });
    }

    return [];
  }

  getStats(data: MergedGridData[]) {
    if (data.length === 0) return { avg: 0, max: 0, count: 0 };
    const values = data.map(d => d.v);
    return {
      avg: values.reduce((a, b) => a + b, 0) / values.length,
      max: Math.max(...values),
      count: data.length
    };
  }

  private generateMockStaticData() {
    const rows = 40;
    const cols = 40;
    const step = 0.015; 
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const id = `TJ-${r}-${c}`;
        this.staticGridMap[id] = {
          lng: TIANJIN_CENTER.lng + (c - cols / 2) * step,
          lat: TIANJIN_CENTER.lat + (r - rows / 2) * step,
        };
      }
    }
  }

  private generateTimeSteps() {
    const now = new Date();
    this.currentTimestamps = [];
    for (let i = 0; i < 48; i++) {
      const d = new Date(now.getTime() - i * 3600000);
      d.setMinutes(0, 0, 0);
      const iso = d.toISOString();
      this.currentTimestamps.push(iso);
      
      this.dynamicTimeline[iso] = Object.keys(this.staticGridMap).map(id => ({
        id,
        v: Math.random() * 150 
      }));
    }
    this.currentTimestamps.sort();
  }

  findTimestampIndex(searchStr: string): number {
    if (!searchStr) return -1;
    const targetDate = new Date(searchStr);
    if (isNaN(targetDate.getTime())) return -1;
    targetDate.setMinutes(0, 0, 0);
    const targetISO = targetDate.toISOString();

    const directIndex = this.currentTimestamps.indexOf(targetISO);
    if (directIndex !== -1) return directIndex;

    let closest = -1;
    let minDiff = Infinity;
    const targetMs = targetDate.getTime();
    this.currentTimestamps.forEach((ts, idx) => {
      const diff = Math.abs(new Date(ts).getTime() - targetMs);
      if (diff < minDiff) {
        minDiff = diff;
        closest = idx;
      }
    });
    return minDiff <= 3600000 ? closest : -1;
  }

  public async getTimestampsAsync(): Promise<string[]> {
    if (this.isLoaded) return this.currentTimestamps;
    // Wait for initialization if called too early
    let attempts = 0;
    while (!this.isLoaded && attempts < 50) {
      await new Promise(r => setTimeout(r, 100));
      attempts++;
    }
    return this.currentTimestamps;
  }

  getTimestamps(): string[] {
    return this.currentTimestamps;
  }
}

export const dataService = new DataService();
