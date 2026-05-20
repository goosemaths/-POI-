/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { GoogleGenAI } from "@google/genai";
import { MergedGridData } from "../types";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

export async function analyzePollution(data: MergedGridData[], timestamp: string) {
  if (!process.env.GEMINI_API_KEY) return "AI Analysis unavailable: API Key not set.";

  try {
    const stats = {
      avg: (data.reduce((a, b) => a + b.v, 0) / data.length).toFixed(1),
      max: Math.max(...data.map(d => d.v)).toFixed(1),
    };

    const highPollutionAreas = data
      .sort((a, b) => b.v - a.v)
      .slice(0, 5)
      .map(d => `Grid ${d.grid_id}: PM2.5 ${d.v.toFixed(1)} (Ind: ${d.cnt_industrial}, Comm: ${d.cnt_commercial}, Trans: ${d.cnt_transport}, Cate: ${d.cnt_catering})`);

    const prompt = `
      As an environmental scientist specializing in Tianjin's urban air quality, analyze the following PM2.5 data for the moment ${new Date(timestamp).toLocaleString()}.
      
      Stats:
      - Average PM2.5: ${stats.avg} ug/m3
      - Maximum PM2.5: ${stats.max} ug/m3
      
      Key Hotspots (High pollution grids with POI attributes):
      ${highPollutionAreas.join('\n')}
      
      Please provide a brief, professional summary (under 120 words) of the current air quality situation in Tianjin.
      Correlate the pollution spikes with the localized Point of Interest (POI) counts provided (Industrial, Commercial, Transport, Catering).
      Offer specific urban planning or health recommendations based on these correlations. Use a direct, authoritative tone.
    `;

    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: prompt,
    });
    
    return response.text || "No analysis generated.";
  } catch (error) {
    console.error("Gemini Analysis Error:", error);
    return "Failed to generate AI analysis.";
  }
}
