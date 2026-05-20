import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import duckdb from 'duckdb';
const { Database } = duckdb;
import fs from 'fs';

// BigInt JSON serialization patch
(BigInt.prototype as any).toJSON = function() {
  return Number(this);
};

// 1. 【修改点一】设置远程 Parquet 文件直链（请替换为您实际的 URL）
const PARQUET_URL = "https://github.com/goosemaths/-POI-/releases/download/v1.0.0/tianjin_pm25_predictions.parquet";

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize DuckDB (In-memory, we will query files directly)
const db = new Database(':memory:');

// 2. 【修改点二】加载网络读取插件（因为 Parquet 在远程，必须加载）
db.run("INSTALL httpfs; LOAD httpfs;");

// Helper to run DuckDB queries
const query = (sql: string): Promise<any[]> => {
  return new Promise((resolve, reject) => {
    db.all(sql, (err, res) => {
      if (err) reject(err);
      else resolve(res);
    });
  });
};

async function startServer() {
  // 本地 CSV 路径保持原样
  const csvFile = path.resolve(process.cwd(), 'grid_static_attributes.csv');
  const jsonFile = path.resolve(process.cwd(), 'data.json');

  // 【修改点三】移除了自愈逻辑（因为 Parquet 放在云端，不再需要本地自动生成）
  console.log(`[DuckDB] Initialization:\n- Remote Parquet: ${PARQUET_URL}\n- Local CSV: ${csvFile}`);

  // API Route: Get available timestamps
  app.get("/api/timestamps", async (req, res) => {
    // 检查本地 CSV 是否存在，并默认远程 Parquet 可访问
    const hasDBFiles = fs.existsSync(csvFile);
    const hasJsonFile = fs.existsSync(jsonFile);
    
    console.log(`[GET /api/timestamps] Querying timestamps...`);

    try {
      if (hasDBFiles) {
        // 读取远程 Parquet 获取时间戳
        const result = await query(`
          SELECT DISTINCT CAST(dt AS VARCHAR) as dt FROM read_parquet('${PARQUET_URL}') ORDER BY dt ASC
        `);
        return res.json(result.map(r => r.dt));
      } else if (hasJsonFile) {
        const result = await query(`
          SELECT DISTINCT key FROM (SELECT UNNEST(timeline) as key FROM read_json_auto('${jsonFile}')) t
        `);
        return res.json(result.map(r => r.key).sort());
      }
      
      console.error(`Local CSV file missing. Looked for: ${csvFile}`);
      res.status(404).json({ error: "Required local CSV file not found" });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // API Route: Get static grid attributes (直接读取本地 CSV)
  app.get("/api/static-grids", async (req, res) => {
    const hasCSVFile = fs.existsSync(csvFile);
    if (!hasCSVFile) {
      return res.status(404).json({ error: "Static attributes CSV file missing on server" });
    }
    try {
      // 路径斜杠格式化（兼容 Windows/Linux）
      const normalizedCsv = csvFile.replace(/\\/g, '/');
      const sql = `
        SELECT 
          CAST(grid_id AS VARCHAR) as id, 
          CAST(lng_wgs84 AS DOUBLE) as lng, 
          CAST(lat_wgs84 AS DOUBLE) as lat,
          CAST(nearest_meteo_id AS VARCHAR) as nearest_meteo_id,
          CAST(cnt_industrial AS INTEGER) as cnt_industrial,
          CAST(cnt_commercial AS INTEGER) as cnt_commercial,
          CAST(cnt_nature AS INTEGER) as cnt_nature,
          CAST(cnt_transport AS INTEGER) as cnt_transport,
          CAST(cnt_catering AS INTEGER) as cnt_catering
        FROM read_csv_auto('${normalizedCsv}')
      `;
      const data = await query(sql);
      console.log(`[DuckDB] Loaded ${data.length} static grid records from local CSV.`);
      return res.json(data);
    } catch (err: any) {
      console.error("[GET /api/static-grids] Error querying local CSV:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // API Route: Get data for a specific timestamp (读取远程 Parquet)
  app.get("/api/data", async (req, res) => {
    const time = req.query.time as string;
    const hasDBFiles = fs.existsSync(csvFile); // 只要本地 CSV 存在即进行下一步
    const hasJsonFile = fs.existsSync(jsonFile);
    
    console.log(`[GET /api/data] Time: ${time}, Source: Remote Parquet`);

    try {
      if (hasDBFiles) {
        // 直接向远程 Parquet URL 查询特定时间的数据
        const sql = `
          SELECT 
            CAST(p.id AS VARCHAR) as id, 
            CAST(p.v AS DOUBLE) as v
          FROM read_parquet('${PARQUET_URL}') p
          WHERE CAST(p.dt AS VARCHAR) = '${time}'
        `;
        const data = await query(sql);
        console.log(`[DuckDB] Query for time ${time} found ${data.length} records.`);
        return res.json(data);
      } else if (hasJsonFile) {
        const normalizedJson = jsonFile.replace(/\\/g, '/');
        const sql = `
          SELECT 
            CAST(t.item.id AS VARCHAR) as id, 
            CAST(t.item.v AS DOUBLE) as v
          FROM (SELECT UNNEST(timeline['${time}']) as item FROM read_json_auto('${normalizedJson}')) t
        `;
        const data = await query(sql);
        return res.json(data);
      }
      res.status(404).json({ error: "Data source files missing" });
    } catch (err: any) {
      console.error("[GET /api/data] Error querying remote Parquet:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
    const csvExists = fs.existsSync(csvFile);
    console.log(`Data Status: Remote Parquet URL configured, Local CSV(${csvExists})`);
  });
}

startServer();
