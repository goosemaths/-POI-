import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import duckdb from 'duckdb';
const { Database } = duckdb;
import fs from 'fs';
import https from 'https';

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

// Hugging Face 原始文件下载直链
const PARQUET_URL = "https://huggingface.co/datasets/goosemaths/tianjin-pm25-data/resolve/main/tianjin_pm25_predictions.parquet";
const LOCAL_PARQUET_PATH = path.resolve(process.cwd(), 'tianjin_pm25_predictions.parquet');

// 自动处理重定向的下载辅助函数
function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    https.get(url, (response) => {
      // 处理 Hugging Face LFS 的 301/302 重定向
      if (response.statusCode === 301 || response.statusCode === 302) {
        if (response.headers.location) {
          downloadFile(response.headers.location, dest).then(resolve).catch(reject);
          return;
        }
      }

      if (response.statusCode !== 200) {
        reject(new Error(`Failed to download file, status code: ${response.statusCode}`));
        return;
      }

      const file = fs.createWriteStream(dest);
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve();
      });
    }).on('error', (err) => {
      fs.unlink(dest, () => {}); 
      reject(err);
    });
  });
}

async function startServer() {
  const csvFile = path.resolve(process.cwd(), 'grid_static_attributes.csv');
  const jsonFile = path.resolve(process.cwd(), 'data.json');

  // 启动时自动从 Hugging Face 下载/同步 Parquet 文件
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

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
