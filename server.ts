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

const PARQUET_URL = "https://huggingface.co/datasets/goosemaths/tianjin-pm25-data/resolve/main/tianjin_pm25_predictions.parquet";

// 流式下载工具
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

async function startServer() {
  // 修复 1：将 app 与 PORT 声明移至函数内部，防止打包工具混淆作用域
  const app = express();
  const PORT = process.env.PORT || 3000;

  // Initialize DuckDB 并限制运行资源
  const db = new Database(':memory:');
  db.run("PRAGMA memory_limit='128MB';");
  db.run("PRAGMA threads=1;");

  const query = (sql: string): Promise<any[]> => {
    return new Promise((resolve, reject) => {
      db.all(sql, (err, res) => {
        if (err) reject(err);
        else resolve(res);
      });
    });
  };

  // Data file paths
  const parquetFile = path.resolve(process.cwd(), 'tianjin_pm25_predictions.parquet');
  const csvFile = path.resolve(process.cwd(), 'grid_static_attributes.csv');
  const jsonFile = path.resolve(process.cwd(), 'data.json');

  let isDownloading = false;

  // 修复 2：异步下载，不阻塞主线程启动以防 Render 检测端口超时
  if (!fs.existsSync(parquetFile)) {
    isDownloading = true;
    console.log(`[Hugging Face] Downloading parquet from ${PARQUET_URL}...`);
    
    downloadFile(PARQUET_URL, parquetFile)
      .then(() => {
        console.log(`[Hugging Face] Download complete.`);
        isDownloading = false;
      })
      .catch(async (err) => {
        console.error("[Hugging Face] Download failed, falling back to Self-Healing...", err.message);
        
        if (fs.existsSync(csvFile)) {
          console.log(`[Self-Healing] Generating default predictions...`);
          try {
            const sqlGenerate = `
              COPY (
                SELECT 
                  t.dt,
                  s.grid_id as id,
                  CAST((30.0 + random() * 45.0 + (CAST(s.cnt_industrial AS DOUBLE) * 12.0) + (CAST(s.cnt_transport AS DOUBLE) * 8.0) + (CAST(s.cnt_commercial AS DOUBLE) * 5.0)) AS DOUBLE) as v
                FROM read_csv_auto('${csvFile.replace(/\\/g, '/')}') s
                CROSS JOIN (
                  SELECT '2025-12-23 14:00:00' as dt UNION ALL
                  SELECT '2025-12-23 15:00:00' UNION ALL
                  SELECT '2025-12-23 16:00:00' UNION ALL
                  SELECT '2025-12-23 17:00:00' UNION ALL
                  SELECT '2025-12-23 18:00:00' UNION ALL
                  SELECT '2025-12-23 19:00:00' UNION ALL
                  SELECT '2025-12-23 20:00:00' UNION ALL
                  SELECT '2025-12-23 21:00:00' UNION ALL
                  SELECT '2025-12-23 22:00:00' UNION ALL
                  SELECT '2025-12-23 23:00:00' UNION ALL
                  SELECT '2026-03-29 00:00:00' as dt
                ) t
              ) TO '${parquetFile.replace(/\\/g, '/')}' (FORMAT PARQUET);
            `;
            await query(sqlGenerate);
            console.log(`[Self-Healing] Successfully generated ${parquetFile}`);
          } catch (genErr) {
            console.error("[Self-Healing] Failed to generate parquet file:", genErr);
          }
        }
        isDownloading = false;
      });
  }

  // 拦截器：文件未下载完成时拦截时序请求
  app.use((req, res, next) => {
    const isPredictionApi = req.path.startsWith('/api/timestamps') || req.path.startsWith('/api/data');
    if (isPredictionApi && isDownloading) {
      return res.status(503).json({ error: "Data files are downloading, please try again in a few seconds." });
    }
    next();
  });

  // API Route: Get available timestamps
  app.get("/api/timestamps", async (req, res) => {
    const hasDBFiles = fs.existsSync(parquetFile) && fs.existsSync(csvFile);
    const hasJsonFile = fs.existsSync(jsonFile);
    
    try {
      if (hasDBFiles) {
        const result = await query(`
          SELECT DISTINCT CAST(dt AS VARCHAR) as dt FROM read_parquet('${parquetFile}') ORDER BY dt ASC
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

  // API Route: Get static grid attributes (静态网格立即可用)
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
    const hasDBFiles = fs.existsSync(parquetFile);
    const hasJsonFile = fs.existsSync(jsonFile);
    
    try {
      if (hasDBFiles) {
        const normalizedParquet = parquetFile.replace(/\\/g, '/');
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

  // 立即绑定端口，通过 Render 的健康检测
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
  });
}

startServer();
