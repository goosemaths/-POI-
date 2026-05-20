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
const PORT = process.env.PORT || 3000;

// Initialize DuckDB
const db = new Database(':memory:');

// 优化 1：严格限制 DuckDB 的内存使用和线程数，防止 512MB 内存溢出
db.run("PRAGMA memory_limit='128MB';");
db.run("PRAGMA threads=1;");

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

// 优化 2：采用流式（Stream Pipe）下载，数据直接落盘，不占用 Node.js 内存运行空间
function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = https.get(url, (response) => {
      // 释放未使用的重定向连接
      if (response.statusCode === 301 || response.statusCode === 302) {
        response.resume(); 
        const redirectUrl = response.headers.location;
        if (redirectUrl) {
          downloadFile(redirectUrl, dest).then(resolve).catch(reject);
        } else {
          reject(new Error("Redirect location missing"));
        }
        return;
      }

      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Failed to download: ${response.statusCode}`));
        return;
      }

      const file = fs.createWriteStream(dest);
      response.pipe(file);

      file.on('finish', () => {
        file.close();
        resolve();
      });

      file.on('error', (err) => {
        fs.unlink(dest, () => {}); 
        reject(err);
      });
    });

    request.on('error', (err) => {
      reject(err);
    });
  });
}

async function startServer() {
  const csvFile = path.resolve(process.cwd(), 'grid_static_attributes.csv');
  const jsonFile = path.resolve(process.cwd(), 'data.json');

  // 启动下载
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
    console.log(`Server running on port ${PORT}`);
  });
}

startServer();
