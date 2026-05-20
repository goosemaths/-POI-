/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface GridPoint {
  grid_id: string;
  lng: number;
  lat: number;
  nearest_meteo_id: string;
  cnt_industrial: number;
  cnt_commercial: number;
  cnt_nature: number;
  cnt_transport: number;
  cnt_catering: number;
}

export interface AirQualityData {
  id: string; // grid_id
  v: number;  // value
  dt: string; // ISO timestamp
}

export interface MergedGridData extends GridPoint {
  v: number;
  color: [number, number, number, number];
}

export interface TimeStep {
  timestamp: string;
  avgValue: number;
  maxValue: number;
}
