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
// 修复 1：动态获取 Render 提供的端口，避免绑定失败
const PORT = process.env.PORT || 3000;

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

const PARQUET_URL = "https://huggingface.co/datasets/goosemaths/tianjin-pm25-data/resolve/main/tianjin_pm25_predictions.parquet";
const LOCAL_PARQUET_PATH = path.resolve(process.cwd(), 'tianjin_pm25_predictions.parquet');

// 修复 2：使用更稳定的内置 fetch API 自动处理重定向与文件写入
async function downloadFile(url: string, dest: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  await fs.promises.writeFile(dest, Buffer.from(arrayBuffer));
}

async function startServer() {
  const csvFile = path.resolve(process.cwd(), 'grid_static_attributes.csv');
  const jsonFile = path.resolve(process.cwd(), 'data.json');

  // 启动时同步 Parquet 数据
  if (!fs.existsSync(LOCAL_PARQUET_PATH)) {
    console.log(`[Hugging Face] Downloading parquet from ${PARQUET_URL}...`);
    try {
      await downloadFile(PARQUET_URL, LOCAL_PARQUET_PATH);
      console.log(`[Hugging Face] Download complete. Saved to ${LOCAL_PARQUET_PATH}`);
    } catch (err: any) {
      console.error("[Hugging Face] Failed to download parquet file:", err.message);
    }
  } else {
    console.log(`[Hugging Face] Using cached parquet file at ${LOCAL_PARQUET_PATH}`);
  }

  // API Route: Get available timestamps
  app.get("/api/timestamps", async (req, res) => {
    const hasDBFiles = fs.existsSync(LOCAL_PARQUET_PATH) && fs.existsSync(csvFile);
    const hasJsonFile = fs.existsSync(jsonFile);
    
    try {
      if (hasDBFiles) {
        const normalizedPath = LOCAL_PARQUET_PATH.replace(/\\/g, '/');
        const result = await query(`
          SELECT DISTINCT CAST(dt AS VARCHAR) as dt FROM read_parquet('${normalizedPath}') ORDER BY dt ASC
        `);
        return res.json(result.map(r => r.dt));
      } else if (hasJsonFile) {
        const result = await query(`
          SELECT DISTINCT key FROM (SELECT UNNEST(timeline) as key FROM read_json_auto('${jsonFile}')) t
        `);
        return res.json(result.map(r => r.key).sort());
      }
      
      res.status(404).json({ error: "Data files not found" });
    } catch (err: any) {
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
      return res.json(data);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // API Route: Get data for a specific timestamp
  app.get("/api/data", async (req, res) => {
    const time = req.query.time as string;
    const hasDBFiles = fs.existsSync(LOCAL_PARQUET_PATH);
    const hasJsonFile = fs.existsSync(jsonFile);
    
    try {
      if (hasDBFiles) {
        const normalizedParquet = LOCAL_PARQUET_PATH.replace(/\\/g, '/');
        const sql = `
          SELECT 
            CAST(p.id AS VARCHAR) as id, 
            CAST(p.v AS DOUBLE) as v
          FROM read_parquet('${normalizedParquet}') p
          WHERE CAST(p.dt AS VARCHAR) = '${time}'
        `;
        const data = await query(sql);
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

  // 绑定至 Render 分配的端口
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
  });
}

startServer();
