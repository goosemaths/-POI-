import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import duckdb from 'duckdb';
const { Database } = duckdb;
import fs from 'fs';
import https from 'https'; // 引入 https 模块用于下载

// BigInt JSON serialization patch
(BigInt.prototype as any).toJSON = function() {
  return Number(this);
};

// 修复 1：Render 要求必须绑定 process.env.PORT
const PORT = process.env.PORT || 3000;

// Initialize DuckDB (In-memory, we will query files directly)
const db = new Database(':memory:');

// 修复 2：严格限制 DuckDB 资源，防止在 Render 512MB 环境下 OOM
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

// 流式下载工具，不占用 Node.js 额外内存空间
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
  // Data file paths
  const parquetFile = path.resolve(process.cwd(), 'tianjin_pm25_predictions.parquet');
  const csvFile = path.resolve(process.cwd(), 'grid_static_attributes.csv');
  const jsonFile = path.resolve(process.cwd(), 'data.json');

  // 修复 3：启动时若缺失文件，优先从 Hugging Face 下载真实数据
  if (!fs.existsSync(parquetFile)) {
    console.log(`[Hugging Face] Downloading dataset from ${PARQUET_URL}...`);
    try {
      await downloadFile(PARQUET_URL, parquetFile);
      console.log(`[Hugging Face] Download complete.`);
    } catch (downloadErr: any) {
      console.error("[Hugging Face] Download failed, falling back to Self-Healing generation...", downloadErr.message);
      
      // 下载失败时，降级使用您原有的自愈逻辑生成虚拟数据
      if (fs.existsSync(csvFile)) {
        console.log(`[Self-Healing] Generating default predictions from static attributes...`);
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
        } catch (err) {
          console.error("[Self-Healing] Failed to generate parquet file:", err);
        }
      }
    }
  }

  // API Route: Get available timestamps
  app.get("/api/timestamps", async (req, res) => {
    const hasDBFiles = fs.existsSync(parquetFile) && fs.existsSync(csvFile);
    const hasJsonFile = fs.existsSync(jsonFile);
    
    console.log(`[GET /api/timestamps] Files: Parquet(${fs.existsSync(parquetFile)}), CSV(${fs.existsSync(csvFile)}), JSON(${hasJsonFile})`);

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
      
      console.error(`Data files missing. Looked for: ${parquetFile} and ${csvFile}`);
      res.status(404).json({ 
        error: "Data files not found", 
        checked: { parquet: parquetFile, csv: csvFile, exists: { parquet: fs.existsSync(parquetFile), csv: fs.existsSync(csvFile) } } 
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // API Route: Get static grid attributes (loaded once at startup)
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

  // API Route: Get data for a specific timestamp (dynamic-only payload, optimized)
  app.get("/api/data", async (req, res) => {
    const time = req.query.time as string;
    const hasDBFiles = fs.existsSync(parquetFile);
    const hasJsonFile = fs.existsSync(jsonFile);
    
    console.log(`[GET /api/data] Time: ${time}, Source: ${hasDBFiles ? 'DuckDB (Parquet Only)' : (hasJsonFile ? 'JSON' : 'None')}`);

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
        console.log(`[DuckDB] Query for time ${time} found ${data.length} records.`);
        if (data.length > 0) {
           console.log(`[DuckDB] Sample dynamic: ID: ${data[0].id}, V: ${data[0].v}`);
        }
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
      console.error("[GET /api/data] Error querying:", err);
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

  // 修复 4：改为使用分配的 PORT
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
    const parquetExists = fs.existsSync(path.resolve(process.cwd(), 'tianjin_pm25_predictions.parquet'));
    const csvExists = fs.existsSync(path.resolve(process.cwd(), 'grid_static_attributes.csv'));
    console.log(`Data Status: Parquet(${parquetExists}), CSV(${csvExists})`);
  });
}

startServer();
