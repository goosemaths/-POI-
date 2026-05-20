import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import duckdb from 'duckdb';
const { Database } = duckdb;
import fs from 'fs';
import https from 'https';

(BigInt.prototype as any).toJSON = function() {
  return Number(this);
};

const app = express();
const PORT = process.env.PORT || 3000;

// 优化：使用本地磁盘文件作为缓存数据库，避免占用 512MB 运行内存
const DB_PATH = path.resolve(process.cwd(), 'local_cache.db');
const db = new Database(DB_PATH);

db.run("PRAGMA memory_limit='64MB';"); // 进一步压低内存限制
db.run("PRAGMA threads=1;");

const query = (sql: string, params: any[] = []): Promise<any[]> => {
  return new Promise((resolve, reject) => {
    db.all(sql, ...params, (err, res) => {
      if (err) reject(err);
      else resolve(res);
    });
  });
};

const PARQUET_URL = "https://huggingface.co/datasets/goosemaths/tianjin-pm25-data/resolve/main/tianjin_pm25_predictions.parquet";
const LOCAL_PARQUET_PATH = path.resolve(process.cwd(), 'tianjin_pm25_predictions.parquet');

function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = https.get(url, (response) => {
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
      file.on('finish', () => { file.close(); resolve(); });
      file.on('error', (err) => { fs.unlink(dest, () => {}); reject(err); });
    });
    request.on('error', (err) => reject(err));
  });
}

// 初始化磁盘缓存表
async function initDatabase() {
  const csvFile = path.resolve(process.cwd(), 'grid_static_attributes.csv');
  const jsonFile = path.resolve(process.cwd(), 'data.json');

  // 1. 检查并导入 static_grids 表
  const hasStaticTable = await query("SELECT table_name FROM information_schema.tables WHERE table_name = 'static_grids'");
  if (hasStaticTable.length === 0 && fs.existsSync(csvFile)) {
    console.log("[DuckDB] Importing static grids to disk cache...");
    const normalizedCsv = csvFile.replace(/\\/g, '/');
    await query(`
      CREATE TABLE static_grids AS 
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
    `);
  }

  // 2. 检查并导入 predictions 表
  const hasPredictionsTable = await query("SELECT table_name FROM information_schema.tables WHERE table_name = 'predictions'");
  if (hasPredictionsTable.length === 0) {
    if (fs.existsSync(LOCAL_PARQUET_PATH)) {
      console.log("[DuckDB] Importing predictions from Parquet to disk cache...");
      const normalizedParquet = LOCAL_PARQUET_PATH.replace(/\\/g, '/');
      await query(`
        CREATE TABLE predictions AS 
        SELECT CAST(dt AS VARCHAR) as dt, CAST(id AS VARCHAR) as id, CAST(v AS DOUBLE) as v 
        FROM read_parquet('${normalizedParquet}')
      `);
      // 建立索引，大幅提升多用户并发查询时的检索速度，同时降低 CPU 消耗
      await query(`CREATE INDEX IF NOT EXISTS idx_pred_dt ON predictions (dt)`);
    } else if (fs.existsSync(jsonFile)) {
      console.log("[DuckDB] Importing predictions from JSON to disk cache...");
      const normalizedJson = jsonFile.replace(/\\/g, '/');
      await query(`
        CREATE TABLE predictions AS
        SELECT 
          CAST(kv.key AS VARCHAR) as dt,
          CAST(val.id AS VARCHAR) as id,
          CAST(val.v AS DOUBLE) as v
        FROM (
          SELECT UNNEST(struct_entries(timeline)) as kv 
          FROM read_json_auto('${normalizedJson}')
        ), LATERAL (
          SELECT UNNEST(kv.value) as val
        )
      `);
      await query(`CREATE INDEX IF NOT EXISTS idx_pred_dt ON predictions (dt)`);
    }
  }
  console.log("[DuckDB] Database tables verified and ready.");
}

async function startServer() {
  if (!fs.existsSync(LOCAL_PARQUET_PATH)) {
    console.log(`[Hugging Face] Downloading parquet from ${PARQUET_URL}...`);
    try {
      await downloadFile(PARQUET_URL, LOCAL_PARQUET_PATH);
    } catch (err: any) {
      console.error("[Hugging Face] Failed to download parquet file:", err.message);
    }
  }

  try {
    await initDatabase();
  } catch (err: any) {
    console.error("[DuckDB] Error initializing database:", err.message);
  }

  app.get("/api/timestamps", async (req, res) => {
    try {
      const result = await query(`SELECT DISTINCT dt FROM predictions ORDER BY dt ASC`);
      return res.json(result.map(r => r.dt));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/static-grids", async (req, res) => {
    try {
      const data = await query(`SELECT * FROM static_grids`);
      return res.json(data);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/data", async (req, res) => {
    const time = req.query.time as string;
    if (!time) return res.status(400).json({ error: "Missing time parameter" });

    try {
      const data = await query(`SELECT id, v FROM predictions WHERE dt = ?`, [time]);
      return res.json(data);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

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
