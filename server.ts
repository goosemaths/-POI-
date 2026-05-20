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

let isPredictionsReady = false;

const DB_PATH = '/tmp/local_cache.db';
const LOCAL_PARQUET_PATH = '/tmp/tianjin_pm25_predictions.parquet';
const PARQUET_URL = "https://huggingface.co/datasets/goosemaths/tianjin-pm25-data/resolve/main/tianjin_pm25_predictions.parquet";

const db = new Database(DB_PATH);

// 优化：合理调整内存限制和配置，防止 OOM
db.run("PRAGMA memory_limit='256MB';"); // 提高至 256MB 保证分配空间
db.run("PRAGMA threads=1;");
db.run("SET preserve_insertion_order=false;"); // 禁用插入顺序保留以降低内存开销

const query = (sql: string, params: any[] = []): Promise<any[]> => {
  return new Promise((resolve, reject) => {
    db.all(sql, ...params, (err, res) => {
      if (err) reject(err);
      else resolve(res);
    });
  });
};

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

// 步骤 1：同步加载静态网格数据
async function initStaticGrids() {
  const csvFile = path.resolve(process.cwd(), 'grid_static_attributes.csv');
  const hasStaticTable = await query("SELECT table_name FROM information_schema.tables WHERE table_name = 'static_grids'");
  
  if (hasStaticTable.length === 0 && fs.existsSync(csvFile)) {
    console.log("[DuckDB] Loading static grids to disk cache...");
    const normalizedCsv = csvFile.replace(/\\/g, '/');
    try {
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
      console.log("[DuckDB] Static grids loaded successfully.");
    } catch (err) {
      // 容错处理：导入失败时清理半截表格，防止下次启动报错
      await query("DROP TABLE IF EXISTS static_grids;");
      throw err;
    }
  }
}

// 步骤 2：异步加载时序数据
async function initPredictions() {
  const jsonFile = path.resolve(process.cwd(), 'data.json');
  const hasPredictionsTable = await query("SELECT table_name FROM information_schema.tables WHERE table_name = 'predictions'");
  
  if (hasPredictionsTable.length === 0) {
    try {
      if (fs.existsSync(LOCAL_PARQUET_PATH)) {
        console.log("[DuckDB] Importing predictions from Parquet to disk...");
        const normalizedParquet = LOCAL_PARQUET_PATH.replace(/\\/g, '/');
        await query(`
          CREATE TABLE predictions AS 
          SELECT CAST(dt AS VARCHAR) as dt, CAST(id AS VARCHAR) as id, CAST(v AS DOUBLE) as v 
          FROM read_parquet('${normalizedParquet}')
        `);
        await query(`CREATE INDEX IF NOT EXISTS idx_pred_dt ON predictions (dt)`);
      } else if (fs.existsSync(jsonFile)) {
        console.log("[DuckDB] Importing predictions from JSON...");
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
    } catch (err) {
      await query("DROP TABLE IF EXISTS predictions;");
      throw err;
    }
  }
}

async function runBackgroundInitialization() {
  try {
    if (!fs.existsSync(LOCAL_PARQUET_PATH)) {
      console.log("[Background] Downloading parquet file...");
      await downloadFile(PARQUET_URL, LOCAL_PARQUET_PATH);
    }
    await initPredictions();
    isPredictionsReady = true;
    console.log("[Background] Predictions cache initialized. System ready.");
  } catch (err: any) {
    console.error("[Background] Initialization failed:", err.message);
  }
}

// 状态拦截
app.use((req, res, next) => {
  const isPredictionApi = req.path.startsWith('/api/timestamps') || req.path.startsWith('/api/data');
  if (isPredictionApi && !isPredictionsReady) {
    return res.status(503).json({ error: "Prediction data is loading, please try again shortly." });
  }
  next();
});

// API 路由: 静态网格
app.get("/api/static-grids", async (req, res) => {
  try {
    const data = await query(`SELECT * FROM static_grids`);
    return res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// API 路由: 时序相关
app.get("/api/timestamps", async (req, res) => {
  try {
    const result = await query(`SELECT DISTINCT dt FROM predictions ORDER BY dt ASC`);
    return res.json(result.map(r => r.dt));
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

async function startServer() {
  try {
    await initStaticGrids();
  } catch (err: any) {
    console.error("[DuckDB] Static grids load failed:", err.message);
  }

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
    runBackgroundInitialization();
  });
}

startServer();
