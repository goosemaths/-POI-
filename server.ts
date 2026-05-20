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

const app = express();
const PORT = 3000;

// Initialize DuckDB (In-memory)
const db = new Database(':memory:');

// Helper to run DuckDB queries
const query = (sql: string): Promise<any[]> => {
  return new Promise((resolve, reject) => {
    db.all(sql, (err, res) => {
      if (err) reject(err);
      else resolve(res);
    });
  });
};

// Hugging Face 直链需使用 /resolve/ 获取原始文件
const PARQUET_URL = "https://huggingface.co/datasets/goosemaths/tianjin-pm25-data/resolve/main/tianjin_pm25_predictions.parquet";

async function startServer() {
  const PORT = 3000;
  
  // Data file paths
  const csvFile = path.resolve(process.cwd(), 'grid_static_attributes.csv');
  const jsonFile = path.resolve(process.cwd(), 'data.json');

  // 初始化 DuckDB 加载 httpfs 扩展以支持 HTTPS 读取
  try {
    await query("INSTALL httpfs; LOAD httpfs;");
    console.log("[DuckDB] Loaded httpfs extension successfully.");
  } catch (err) {
    console.error("[DuckDB] Failed to load httpfs extension:", err);
  }

  // API Route: Get available timestamps
  app.get("/api/timestamps", async (req, res) => {
    const hasJsonFile = fs.existsSync(jsonFile);
    
    console.log(`[GET /api/timestamps] Source: Remote Parquet`);

    try {
      // 优先从远程 Parquet 读取
      const result = await query(`
        SELECT DISTINCT CAST(dt AS VARCHAR) as dt FROM read_parquet('${PARQUET_URL}') ORDER BY dt ASC
      `);
      return res.json(result.map(r => r.dt));
    } catch (err: any) {
      console.warn("[GET /api/timestamps] Remote parquet failed, trying JSON fallback:", err.message);
      
      if (hasJsonFile) {
        try {
          const result = await query(`
            SELECT DISTINCT key FROM (SELECT UNNEST(timeline) as key FROM read_json_auto('${jsonFile}')) t
          `);
          return res.json(result.map(r => r.key).sort());
        } catch (jsonErr: any) {
          return res.status(500).json({ error: jsonErr.message });
        }
      }
      res.status(500).json({ error: err.message });
    }
  });

  // API Route: Get static grid attributes
  app.get("/api/static-grids", async (req, res) => {
    const hasCSVFile = fs.existsSync(csvFile);
    if (!hasCSVFile) {
      return res.status(404).json({ error: "Static attributes CSV file missing" });
    }
    try {
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
      console.log(`[DuckDB] Loaded ${data.length} static grid records.`);
      return res.json(data);
    } catch (err: any) {
      console.error("[GET /api/static-grids] Error querying:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // API Route: Get data for a specific timestamp
  app.get("/api/data", async (req, res) => {
    const time = req.query.time as string;
    const hasJsonFile = fs.existsSync(jsonFile);
    
    console.log(`[GET /api/data] Time: ${time}, Source: Remote Parquet`);

    try {
      // 优先从远程 Parquet 读取
      const sql = `
        SELECT 
          CAST(p.id AS VARCHAR) as id, 
          CAST(p.v AS DOUBLE) as v
        FROM read_parquet('${PARQUET_URL}') p
        WHERE CAST(p.dt AS VARCHAR) = '${time}'
      `;
      const data = await query(sql);
      return res.json(data);
    } catch (err: any) {
      console.warn("[GET /api/data] Remote parquet failed, trying JSON fallback:", err.message);
      
      if (hasJsonFile) {
        try {
          const normalizedJson = jsonFile.replace(/\\/g, '/');
          const sql = `
            SELECT 
              CAST(t.item.id AS VARCHAR) as id, 
              CAST(t.item.v AS DOUBLE) as v
            FROM (SELECT UNNEST(timeline['${time}']) as item FROM read_json_auto('${normalizedJson}')) t
          `;
          const data = await query(sql);
          return res.json(data);
        } catch (jsonErr: any) {
          return res.status(500).json({ error: jsonErr.message });
        }
      }
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
    console.log(`Server running on http://localhost:${PORT}`);
    const csvExists = fs.existsSync(path.resolve(process.cwd(), 'grid_static_attributes.csv'));
    console.log(`Data Status: Remote Parquet URL configured, CSV(${csvExists})`);
  });
}

startServer();
