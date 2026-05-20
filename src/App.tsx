/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import DeckGL from '@deck.gl/react';
import { ColumnLayer } from '@deck.gl/layers';
import { AmbientLight, PointLight, LightingEffect } from '@deck.gl/core';
import { Map } from 'react-map-gl/maplibre';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Play, 
  Pause, 
  Search, 
  Activity, 
  Factory, 
  ChevronRight, 
  ChevronLeft,
  Sparkles,
  Wind,
  Maximize2,
  Sliders,
  Filter,
  Building,
  Trees,
  Bus,
  MapPin,
  Calendar
} from 'lucide-react';
import { dataService } from './services/dataService';
import { analyzePollution } from './services/geminiService';
import { MergedGridData } from './types';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Initial Map Settings (Centered on the true coordinates of Tianjin: 117.365, 39.26)
const INITIAL_VIEW_STATE = {
  longitude: 117.365,
  latitude: 39.26,
  zoom: 10,
  pitch: 52,
  bearing: 25
};

const MAP_STYLE = "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";

export default function App() {
  const [data, setData] = useState<MergedGridData[]>([]);
  const [timestamps, setTimestamps] = useState<string[]>([]);
  const [currentTimeIndex, setCurrentTimeIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [dateSearch, setDateSearch] = useState('');
  const [isAiPanelOpen, setIsAiPanelOpen] = useState(false);
  const [aiAnalysis, setAiAnalysis] = useState<string | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [viewState, setViewState] = useState(INITIAL_VIEW_STATE);
  const [hoverInfo, setHoverInfo] = useState<any>(null);

  // Advanced Visual adjustments of pillars
  const [pillarRadius, setPillarRadius] = useState(240); // Standard thick block
  const [pillarElevation, setPillarElevation] = useState(35); // Dramatic height scale
  const [activePoiFilter, setActivePoiFilter] = useState<'all' | 'industrial' | 'commercial' | 'nature' | 'transport' | 'catering'>('all');

  // Initialize timestamps
  useEffect(() => {
    const fetchTimestamps = async () => {
      const ts = await dataService.getTimestampsAsync();
      if (ts.length > 0) {
        setTimestamps(ts);
        // Start from the current latest
        setCurrentTimeIndex(ts.length - 1);
      }
    };
    fetchTimestamps();
  }, []);

  const currentTimestamp = timestamps[currentTimeIndex];

  // Fetch current data frame async
  useEffect(() => {
    if (!currentTimestamp) return;
    let isMounted = true;
    dataService.getMergedData(currentTimestamp).then(res => {
      if (!isMounted) return;
      setData(res);
    });
    return () => { isMounted = false; };
  }, [currentTimestamp]);

  const stats = useMemo(() => dataService.getStats(data), [data]);

  // Aggregate POI statistics across active records to build the "City Profile Chart"
  const aggregatedPoiStats = useMemo(() => {
    const totals = {
      industrial: 0,
      commercial: 0,
      nature: 0,
      transport: 0,
      catering: 0,
      total: 0
    };
    data.forEach(d => {
      totals.industrial += d.cnt_industrial || 0;
      totals.commercial += d.cnt_commercial || 0;
      totals.nature += d.cnt_nature || 0;
      totals.transport += d.cnt_transport || 0;
      totals.catering += d.cnt_catering || 0;
    });
    totals.total = totals.industrial + totals.commercial + totals.nature + totals.transport + totals.catering;
    return totals;
  }, [data]);

  // Lighting effects for DeckGL which makes extrusion shadows look incredibly dynamic
  const lightingEffect = useMemo(() => {
    const ambientLight = new AmbientLight({
      color: [255, 255, 255],
      intensity: 1.1
    });
    const pointLight = new PointLight({
      color: [255, 250, 240],
      intensity: 2.2,
      position: [113.82, 36.66, 12000]
    });
    return new LightingEffect({ambientLight, pointLight});
  }, []);

  // Handle Date Search
  const handleDateSearch = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    const index = dataService.findTimestampIndex(dateSearch);
    if (index !== -1) {
      setCurrentTimeIndex(index);
      setIsPlaying(false);
    }
  }, [dateSearch]);

  // Handle Playback Interval with frame-interpolation smooth durations
  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (isPlaying) {
      interval = setInterval(() => {
        setCurrentTimeIndex((prev) => (prev + 1) % timestamps.length);
      }, 700); // Bullet-fast and smooth transitions
    }
    return () => clearInterval(interval);
  }, [isPlaying, timestamps.length]);

  // AI Analysis Trigger
  const handleAiAnalysis = async () => {
    setIsAnalyzing(true);
    setIsAiPanelOpen(true);
    const result = await analyzePollution(data, currentTimestamp);
    setAiAnalysis(result);
    setIsAnalyzing(false);
  };

  // Search filter & POI isolation logic
  const filteredData = useMemo(() => {
    let result = data;
    if (searchQuery) {
      result = result.filter(d => d.grid_id.toLowerCase().includes(searchQuery.toLowerCase()));
    }
    if (activePoiFilter !== 'all') {
      if (activePoiFilter === 'industrial') result = result.filter(d => d.cnt_industrial > 0);
      else if (activePoiFilter === 'commercial') result = result.filter(d => d.cnt_commercial > 0);
      else if (activePoiFilter === 'nature') result = result.filter(d => d.cnt_nature > 0);
      else if (activePoiFilter === 'transport') result = result.filter(d => d.cnt_transport > 0);
      else if (activePoiFilter === 'catering') result = result.filter(d => d.cnt_catering > 0);
    }
    return result;
  }, [data, searchQuery, activePoiFilter]);

  // DeckGL Layers: Re-render is optimized via useMemo; custom transition easing yields extremely smooth temporal evolution.
  // Memoizing layers avoids CPU reallocation during panning and dragging.
  const layers = useMemo(() => [
    new ColumnLayer({
      id: 'column-layer',
      data: filteredData,
      diskResolution: 8, // Half the vertex count (8 instead of 16) yields ~2x rendering speed on 22k pillars
      radius: pillarRadius, 
      extruded: true,
      pickable: true,
      elevationScale: pillarElevation, 
      getPosition: (d: any) => [d.lng, d.lat],
      getFillColor: (d: any) => d.color,
      getElevation: (d: any) => d.v,
      opacity: 0.92,
      material: {
        ambient: 0.2,
        diffuse: 0.8,
        shininess: 90,
        specularColor: [255, 255, 255]
      },
      transitions: {
        getElevation: {
          duration: 350,
          easing: (t: number) => t === 1 ? 1 : 1 - Math.pow(2, -10 * t) // Elastic expo-out
        },
        getFillColor: {
          duration: 350,
          easing: (t: number) => t === 1 ? 1 : 1 - Math.pow(2, -10 * t)
        }
      },
      onHover: (info) => setHoverInfo(info.object ? info : null),
      updateTriggers: {
        getPosition: [filteredData],
        getFillColor: [filteredData],
        getElevation: [filteredData]
      }
    })
  ], [filteredData, pillarRadius, pillarElevation]);

  return (
    <div className="relative w-screen h-screen overflow-hidden font-sans text-white/90 selection:bg-brand-primary/30">
      {/* 3D Map canvas */}
      <div className="absolute inset-0 w-full h-full z-0">
        <DeckGL
          viewState={viewState as any}
          onViewStateChange={({viewState: nextViewState}) => setViewState(nextViewState as any)}
          controller={{
            dragRotate: true,
            touchRotate: true,
            doubleClickZoom: true
          }}
          layers={layers}
          effects={lightingEffect ? [lightingEffect] : []}
          style={{ position: 'absolute', top: '0px', left: '0px', width: '100%', height: '100%' }}
        >
          <Map 
            viewState={viewState as any}
            mapStyle={MAP_STYLE}
            antialias={true}
          />
        </DeckGL>
      </div>

      {/* Brand Header */}
      <div className="absolute top-6 left-6 flex flex-col gap-4 pointer-events-none">
        <motion.div 
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className="pointer-events-auto"
        >
          <div className="glass-panel px-6 py-4 rounded-xl flex items-center gap-4 bg-[#09090b]/80 shadow-[0_8px_32px_0_rgba(0,0,0,0.5)] border-white/10">
            <div className="relative">
              <div className="absolute inset-0 bg-brand-primary blur-md opacity-30 animate-pulse" />
              <div className="relative bg-brand-primary p-2.5 rounded-lg">
                <Wind className="w-5 h-5 text-black" />
              </div>
            </div>
            <div>
              <h1 className="text-xl font-black tracking-tighter brand-glow flex items-center gap-1.5">
                TJ-SPA-AIR <span className="text-brand-primary font-mono text-sm px-1.5 py-0.5 rounded bg-brand-primary/10 select-none font-bold">3D COGNITION</span>
              </h1>
              <p className="text-[10px] text-slate-400 font-mono mt-0.5 flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-[#00e400] animate-ping" /> MULTI-POI GRID ALIGNMENT
              </p>
            </div>
          </div>
        </motion.div>
      </div>

      {/* Filter / Query Header Controller */}
      <div className="absolute top-6 right-6 flex flex-wrap gap-3 pointer-events-auto items-center justify-end max-w-xl">
        <form onSubmit={handleDateSearch} className="glass-panel flex items-center p-1 rounded-full bg-[#09090b]/80 border-white/10 focus-within:border-brand-primary/30 transition-all">
          <div className="relative px-3.5 py-1.5 flex items-center gap-2 border-r border-white/5">
             <Search className="w-3.5 h-3.5 text-slate-400" />
             <input 
              type="text" 
              placeholder="Search ID..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="bg-transparent text-xs w-24 focus:outline-none placeholder:text-slate-500 font-mono"
             />
          </div>
          <div className="relative px-3 py-1 flex items-center gap-2">
             <Calendar className="w-3.5 h-3.5 text-slate-400" />
             <input 
              type="datetime-local" 
              value={dateSearch}
              onChange={(e) => setDateSearch(e.target.value)}
              className="bg-transparent text-[11px] w-36 focus:outline-none [color-scheme:dark] font-mono"
             />
             <button 
              type="submit"
              className="bg-brand-primary/10 hover:bg-brand-primary hover:text-black hover:scale-105 px-2.5 py-1 rounded-full text-[10px] font-mono text-brand-primary transition-all"
             >
               Go
             </button>
          </div>
        </form>

        <button 
          onClick={handleAiAnalysis}
          className="glass-panel px-4 py-2.5 rounded-full flex items-center gap-2 bg-brand-secondary/10 hover:bg-brand-secondary/20 hover:scale-105 active:scale-95 transition-all text-sm font-semibold text-brand-secondary border-brand-secondary/20 animate-none"
        >
          <Sparkles className={cn("w-4 h-4", isAnalyzing ? "animate-spin text-white" : "text-brand-secondary")} />
          <span>Spatial AI</span>
        </button>
      </div>

      {/* POI Overlay Categories Toolbar */}
      <div className="absolute top-24 left-6 pointer-events-auto flex items-center gap-1.5 p-1 glass-panel bg-[#09090b]/70 border-white/10 rounded-full text-[11px] font-medium leading-none">
        <button 
          onClick={() => setActivePoiFilter('all')}
          className={cn("px-3 py-1.5 rounded-full transition-all flex items-center gap-1", activePoiFilter === 'all' ? "bg-white text-black font-semibold shadow" : "text-slate-400 hover:text-white")}
        >
          All Grids
        </button>
        <button 
          onClick={() => setActivePoiFilter('industrial')}
          className={cn("px-3 py-1.5 rounded-full transition-all flex items-center gap-1", activePoiFilter === 'industrial' ? "bg-red-500/20 text-red-300 font-semibold border border-red-500/30" : "text-slate-400 hover:text-white")}
        >
          <Factory className="w-3 h-3" /> Industrial
        </button>
        <button 
          onClick={() => setActivePoiFilter('commercial')}
          className={cn("px-3 py-1.5 rounded-full transition-all flex items-center gap-1", activePoiFilter === 'commercial' ? "bg-sky-500/20 text-sky-300 font-semibold border border-sky-500/30" : "text-slate-400 hover:text-white")}
        >
          <Building className="w-3 h-3" /> Commercial
        </button>
        <button 
          onClick={() => setActivePoiFilter('nature')}
          className={cn("px-3 py-1.5 rounded-full transition-all flex items-center gap-1", activePoiFilter === 'nature' ? "bg-emerald-500/20 text-emerald-300 font-semibold border border-emerald-500/30" : "text-slate-400 hover:text-white")}
        >
          <Trees className="w-3 h-3" /> Nature
        </button>
        <button 
          onClick={() => setActivePoiFilter('transport')}
          className={cn("px-3 py-1.5 rounded-full transition-all flex items-center gap-1", activePoiFilter === 'transport' ? "bg-yellow-500/20 text-yellow-300 font-semibold border border-yellow-500/30" : "text-slate-400 hover:text-white")}
        >
          <Bus className="w-3 h-3" /> Transport
        </button>
        <button 
          onClick={() => setActivePoiFilter('catering')}
          className={cn("px-3 py-1.5 rounded-full transition-all flex items-center gap-1", activePoiFilter === 'catering' ? "bg-purple-500/20 text-purple-300 font-semibold border border-purple-500/30" : "text-slate-400 hover:text-white")}
        >
          <MapPin className="w-3 h-3" /> Catering
        </button>
      </div>

      {/* HUD Metrics & Analytics Dashboard (Left panel, below toolbar) */}
      <div className="absolute bottom-10 left-6 flex flex-col gap-4 pointer-events-none max-w-[340px] w-full">
        
        {/* Advanced Spatial Control Adjusters (Radius / Height) */}
        <motion.div 
          initial={{ opacity: 0, x: -30 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.4, delay: 0.1 }}
          className="glass-panel p-5 rounded-2xl bg-[#09090b]/80 border-white/10 pointer-events-auto shadow-2xl space-y-3.5"
        >
          <div className="flex items-center gap-1.5 text-[11px] font-bold text-slate-400 uppercase tracking-widest border-b border-white/5 pb-2">
            <Sliders className="w-3.5 h-3.5 text-brand-primary" /> Visual Core Engine
          </div>
          
          <div className="space-y-1">
            <div className="flex justify-between text-xs font-mono text-slate-400">
              <span>Radius (Thickness)</span>
              <span className="text-brand-primary">{pillarRadius}m</span>
            </div>
            <input 
              type="range"
              min="100"
              max="900"
              step="20"
              value={pillarRadius}
              onChange={(e) => setPillarRadius(parseInt(e.target.value))}
              className="w-full select-none cursor-pointer h-1.5 bg-white/10 rounded-lg appearance-none accent-brand-primary"
            />
          </div>

          <div className="space-y-1">
            <div className="flex justify-between text-xs font-mono text-slate-400">
              <span>Pillar Extrusion Scale</span>
              <span className="text-brand-primary">x{pillarElevation}</span>
            </div>
            <input 
              type="range"
              min="5"
              max="150"
              step="5"
              value={pillarElevation}
              onChange={(e) => setPillarElevation(parseInt(e.target.value))}
              className="w-full select-none cursor-pointer h-1.5 bg-white/10 rounded-lg appearance-none accent-brand-primary"
            />
          </div>
        </motion.div>

        {/* Aggregated Urban POI Signatures */}
        <motion.div
          initial={{ opacity: 0, x: -30 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.4, delay: 0.2 }}
          className="glass-panel p-5 rounded-2xl bg-[#09090b]/80 border-white/10 pointer-events-auto shadow-2xl space-y-3.5"
        >
          <div className="flex items-center justify-between border-b border-white/5 pb-2">
            <span className="text-[11px] font-bold text-slate-400 uppercase tracking-widest flex items-center gap-1.5">
              <Filter className="w-3.5 h-3.5 text-brand-secondary" /> POI Density Weighting
            </span>
            <span className="text-[9px] font-mono text-slate-500 font-bold">Totals: {aggregatedPoiStats.total}</span>
          </div>

          <div className="space-y-2.5 text-xs">
            <PoiStatusBar 
              label="Industrial Profile" 
              count={aggregatedPoiStats.industrial} 
              color="bg-red-500" 
              ratio={aggregatedPoiStats.total ? (aggregatedPoiStats.industrial / aggregatedPoiStats.total) : 0} 
            />
            <PoiStatusBar 
              label="Commercial Profile" 
              count={aggregatedPoiStats.commercial} 
              color="bg-sky-400" 
              ratio={aggregatedPoiStats.total ? (aggregatedPoiStats.commercial / aggregatedPoiStats.total) : 0} 
            />
            <PoiStatusBar 
              label="Nature Profile" 
              count={aggregatedPoiStats.nature} 
              color="bg-emerald-400" 
              ratio={aggregatedPoiStats.total ? (aggregatedPoiStats.nature / aggregatedPoiStats.total) : 0} 
            />
            <PoiStatusBar 
              label="Transport Profile" 
              count={aggregatedPoiStats.transport} 
              color="bg-yellow-400" 
              ratio={aggregatedPoiStats.total ? (aggregatedPoiStats.transport / aggregatedPoiStats.total) : 0} 
            />
            <PoiStatusBar 
              label="Catering Profile" 
              count={aggregatedPoiStats.catering} 
              color="bg-purple-400" 
              ratio={aggregatedPoiStats.total ? (aggregatedPoiStats.catering / aggregatedPoiStats.total) : 0} 
            />
          </div>
        </motion.div>

        {/* Dynamic Station Metrics */}
        <motion.div 
          initial={{ opacity: 0, x: -25 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.4, delay: 0.3 }}
          className="flex gap-3 pointer-events-auto"
        >
          <div className="glass-panel p-4 rounded-xl flex-1 bg-[#09090b]/80 border-white/10">
            <div className="text-slate-400 text-[10px] uppercase tracking-wider mb-1 flex items-center gap-1 font-mono">
              <Activity className="w-3.5 h-3.5 text-brand-primary" /> Average PM2.5
            </div>
            <div className="text-2xl font-black text-brand-primary font-mono">{stats.avg.toFixed(1)}</div>
            <div className="text-[9px] text-slate-500 italic mt-0.5">μg/m³ Mean</div>
          </div>
          <div className="glass-panel p-4 rounded-xl flex-1 bg-[#09090b]/80 border-white/10">
             <div className="text-slate-400 text-[10px] uppercase tracking-wider mb-1 flex items-center gap-1 font-mono">
              <Maximize2 className="w-3.5 h-3.5 text-rose-500" /> Peak PM2.5
            </div>
            <div className="text-2xl font-black text-rose-500 font-mono">{stats.max.toFixed(1)}</div>
            <div className="text-[9px] text-slate-500 italic mt-0.5">μg/m³ Maximum</div>
          </div>
        </motion.div>
      </div>

      {/* Timeline Playback Dashboard (Bottom Right) */}
      <div className="absolute bottom-10 right-6 pointer-events-none max-w-lg w-full">
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.3 }}
          className="glass-panel p-5 rounded-2xl bg-[#09090b]/85 border-white/10 pointer-events-auto shadow-2xl flex flex-col gap-4"
        >
          <div className="flex justify-between items-center">
            <div className="space-y-0.5 font-sans">
              <span className="text-[9px] uppercase tracking-widest font-mono text-slate-500">Chronological Spaceframe</span>
              <div className="text-base font-bold font-mono text-white tracking-tight">
                {currentTimestamp ? new Date(currentTimestamp).toLocaleString(undefined, { 
                  month: 'short', 
                  day: 'numeric', 
                  hour: '2-digit', 
                  minute: '2-digit',
                  hour12: false
                }) : "Initializing..."}
              </div>
            </div>
            
            <div className="flex items-center gap-2">
              <button 
                onClick={() => {
                  setCurrentTimeIndex((prev) => (prev - 1 + timestamps.length) % timestamps.length);
                  setIsPlaying(false);
                }}
                className="w-8 h-8 rounded-full border border-white/10 flex items-center justify-center hover:bg-white/10 hover:border-white/20 active:scale-95 transition-all text-slate-300"
                title="Previous Frame"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>

              <button 
                onClick={() => setIsPlaying(!isPlaying)}
                className="w-10 h-10 bg-brand-primary text-black rounded-full flex items-center justify-center hover:scale-110 active:scale-95 transition-all shadow-lg hover:shadow-brand-primary/20 animate-none"
                title={isPlaying ? "Pause Timeline" : "Play Timeline"}
              >
                {isPlaying ? <Pause className="w-4 h-4 fill-current" /> : <Play className="w-4 h-4 fill-current translate-x-0.5" />}
              </button>

              <button 
                onClick={() => {
                  setCurrentTimeIndex((prev) => (prev + 1) % timestamps.length);
                  setIsPlaying(false);
                }}
                className="w-8 h-8 rounded-full border border-white/10 flex items-center justify-center hover:bg-white/10 hover:border-white/20 active:scale-95 transition-all text-slate-300"
                title="Next Frame"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
          
          <div className="relative h-2 bg-white/10 rounded-full overflow-hidden group cursor-pointer transition-all">
            <input 
              type="range"
              min="0"
              max={timestamps.length ? timestamps.length - 1 : 0}
              value={currentTimeIndex}
              onChange={(e) => {
                setCurrentTimeIndex(parseInt(e.target.value));
                setIsPlaying(false);
              }}
              className="absolute inset-0 w-full opacity-0 z-20 cursor-pointer"
            />
            <div 
              className="absolute inset-y-0 left-0 bg-brand-primary group-hover:bg-brand-primary/80 transition-all rounded-full"
              style={{ width: `${timestamps.length ? (currentTimeIndex / (timestamps.length - 1)) * 100 : 0}%` }}
            />
          </div>
          
          <div className="flex justify-between items-center text-[9px] text-slate-500 font-mono">
            <span>START FRAME</span>
            <span className="text-brand-primary">Frame {currentTimeIndex + 1}/{timestamps.length}</span>
            <span>END FRAME</span>
          </div>
        </motion.div>
      </div>

      {/* AI Intelligence Advisory Side Panel */}
      <AnimatePresence>
        {isAiPanelOpen && (
          <motion.div 
            initial={{ x: '100%', opacity: 0.8 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: '100%', opacity: 0.8 }}
            transition={{ type: 'spring', damping: 28, stiffness: 220 }}
            className="absolute top-0 right-0 h-full w-[400px] glass-panel bg-[#09090b]/95 border-l border-white/10 p-8 flex flex-col gap-6 z-40 shadow-[-10px_0_40px_rgba(0,0,0,0.8)]"
          >
            <div className="flex justify-between items-center border-b border-white/5 pb-4 mt-12 md:mt-0 font-sans">
              <div className="flex items-center gap-2">
                <Sparkles className="w-5 h-5 text-brand-secondary animate-none" />
                <h2 className="text-lg font-black tracking-tight text-white/90">GeoAI Cloud Analyst</h2>
              </div>
              <button 
                onClick={() => setIsAiPanelOpen(false)}
                className="hover:bg-white/5 border border-white/0 hover:border-white/10 p-2 rounded-xl transition-all"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto custom-scrollbar pr-3">
              {isAnalyzing ? (
                <div className="flex flex-col items-center justify-center h-52 gap-4">
                  <div className="w-7 h-7 border-2 border-brand-primary border-t-transparent rounded-full animate-spin" />
                  <p className="text-xs font-mono text-slate-400 animate-pulse">Running advanced PM2.5 & POI model inference...</p>
                </div>
              ) : (
                <div className="space-y-6">
                  <div className="bg-white/5 border border-white/5 p-4 rounded-xl">
                    <p className="text-xs text-slate-300 leading-relaxed italic">
                      "{aiAnalysis || 'Awaiting activation trigger. Select timeline moment and press Expert Analysis for environmental correlation synthesis.'}"
                    </p>
                  </div>
                  
                  <div className="space-y-3">
                    <h3 className="text-xs font-mono uppercase text-slate-400 tracking-wider">Pollution Priority Nodes</h3>
                    <div className="grid grid-cols-1 gap-2.5">
                       {data.sort((a,b) => b.v - a.v).slice(0, 3).map((grid, index) => (
                          <div key={grid.grid_id} className="bg-white/5 rounded-xl p-3.5 border border-white/5 flex justify-between items-center bg-[#0d0d0f]/60 hover:border-white/10 transition-colors">
                            <div>
                              <div className="text-[10px] font-mono text-slate-500">NO.{index + 1} GRID STATION</div>
                              <div className="text-xs font-bold font-mono mt-0.5">{grid.grid_id} (Meteo: {grid.nearest_meteo_id})</div>
                              <div className="flex items-center gap-2 mt-1.5 text-[10px] text-slate-400">
                                <span>🏭 Ind: {grid.cnt_industrial}</span>
                                <span>🛒 Comm: {grid.cnt_commercial}</span>
                              </div>
                            </div>
                            <div className="text-right flex flex-col items-end">
                              <div className="text-[9px] font-mono text-slate-500">PM2.5</div>
                              <div className="text-sm font-black text-rose-500 font-mono">{grid.v.toFixed(1)}</div>
                            </div>
                          </div>
                       ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
            
            <div className="bg-[#00e400]/5 border border-[#00e400]/15 p-4 rounded-xl">
               <div className="text-[10px] font-mono text-brand-primary uppercase tracking-widest mb-1.5 font-bold">Health Guidelines</div>
               <p className="text-xs text-slate-300 leading-normal">
                 In locations highlighting heavy industrial activity or transit hubs combined with PM2.5 concentrations exceeding 75μg/m³, automated particulate filtration and specialized breathing shields are recommended for all active operations.
               </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Extreme Detail Tooltip (POI columns explicitly labeled) */}
      {hoverInfo && (
        <div 
          style={{ left: hoverInfo.x + 15, top: hoverInfo.y + 15 }}
          className="absolute z-50 pointer-events-none glass-panel p-4.5 rounded-2xl min-w-[240px] bg-[#09090b]/95 border-white/15 shadow-2xl text-xs"
        >
          <div className="flex justify-between items-start mb-2.5">
            <div>
              <span className="text-[10px] font-mono text-slate-400">ID: {hoverInfo.object.grid_id}</span>
              <div className="text-[9px] font-mono text-slate-500 mt-0.5">Meteo Station: {hoverInfo.object.nearest_meteo_id}</div>
            </div>
            <div className="flex items-center gap-1 hover:scale-105 transition-all bg-brand-primary/10 px-2 py-0.5 rounded border border-brand-primary/20 text-brand-primary">
               <Activity className="w-3.5 h-3.5 animate-none" />
               <span className="font-bold font-mono">{hoverInfo.object.v.toFixed(1)}</span>
            </div>
          </div>
          
          <div className="h-px bg-white/5 my-2.5" />
          
          <div className="space-y-2">
            <TooltipBar label="Industrial Attribute" value={Number(hoverInfo.object.cnt_industrial || 0)} max={12} color="bg-red-500" />
            <TooltipBar label="Commercial Attribute" value={Number(hoverInfo.object.cnt_commercial || 0)} max={12} color="bg-sky-400" />
            <TooltipBar label="Nature Attribute" value={Number(hoverInfo.object.cnt_nature || 0)} max={12} color="bg-emerald-400" />
            <TooltipBar label="Transport Attribute" value={Number(hoverInfo.object.cnt_transport || 0)} max={12} color="bg-yellow-400" />
            <TooltipBar label="Catering Attribute" value={Number(hoverInfo.object.cnt_catering || 0)} max={12} color="bg-purple-400" />
          </div>
          
          <div className="mt-3.5 flex gap-1 font-sans">
             <div className="h-1 flex-1 rounded-full bg-[#00e400]" style={{ opacity: hoverInfo.object.v < 35 ? 1 : 0.15 }} />
             <div className="h-1 flex-1 rounded-full bg-yellow-400" style={{ opacity: hoverInfo.object.v >= 35 && hoverInfo.object.v < 75 ? 1 : 0.15 }} />
             <div className="h-1 flex-1 rounded-full bg-orange-500" style={{ opacity: hoverInfo.object.v >= 75 && hoverInfo.object.v < 115 ? 1 : 0.15 }} />
             <div className="h-1 flex-1 rounded-full bg-rose-600" style={{ opacity: hoverInfo.object.v >= 115 ? 1 : 0.15 }} />
          </div>
        </div>
      )}

      {/* Compact Interactive Legend */}
      <div className="absolute top-24 right-6 glass-panel p-4 rounded-2xl bg-[#09090b]/80 border-white/10 flex flex-col gap-2 pointer-events-auto shadow-xl select-none font-sans">
        <div className="text-[10px] text-slate-500 font-bold uppercase tracking-wider text-center flex items-center gap-1 justify-center">
           <Wind className="w-3 h-3 text-brand-primary animate-none" /> PM2.5 Scale
        </div>
        <div className="space-y-1.5 border-t border-white/5 pt-1.5 font-sans">
          <LegendItem color="bg-[#00e400]" label="Good" range="0-35" />
          <LegendItem color="bg-yellow-400" label="Moderate" range="36-75" />
          <LegendItem color="bg-orange-500" label="Slight Alerts" range="76-115" />
          <LegendItem color="bg-rose-500" label="Unhealthy" range="116-150" />
          <LegendItem color="bg-purple-600" label="Critical" range="151+" />
        </div>
      </div>
    </div>
  );
}

// Subcomponents helper to isolate rendering structures beautifully
function TooltipBar({ label, value, max, color }: { label: string, value: number, max: number, color: string }) {
  const percent = Math.min((value / max) * 100, 100);
  return (
    <div className="space-y-0.5 font-sans">
      <div className="flex justify-between text-[10px] text-slate-400 font-mono">
        <span>{label}</span>
        <span className="font-bold">{value}</span>
      </div>
      <div className="h-1 bg-white/5 rounded-full overflow-hidden">
        <div className={cn("h-full rounded-full transition-all duration-300", color)} style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

function PoiStatusBar({ label, count, color, ratio }: { label: string, count: number, color: string, ratio: number }) {
  return (
    <div className="space-y-1 font-sans">
      <div className="flex justify-between text-[10px] font-mono text-slate-400">
        <span>{label}</span>
        <span>{count} units</span>
      </div>
      <div className="h-1.5 bg-white/5 rounded-full overflow-hidden relative">
        <div 
          className={cn("h-full rounded-full transition-all duration-500", color)} 
          style={{ width: `${ratio * 100}%` }} 
        />
      </div>
    </div>
  );
}

function LegendItem({ color, label, range }: { color: string, label: string, range: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <div className={cn("w-2 h-2 rounded-full shadow", color)} />
      <span className="text-[10px] text-slate-300 w-16 select-none leading-none">{label}</span>
      <span className="text-[9px] text-slate-500 font-mono leading-none select-none">{range}</span>
    </div>
  );
}
