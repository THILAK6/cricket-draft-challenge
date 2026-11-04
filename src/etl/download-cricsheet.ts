import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const DATA_RAW_DIR = path.resolve(process.cwd(), "data/raw");
const PEOPLE_URL = "https://cricsheet.org/register/people.csv";
const T20S_URL = "https://cricsheet.org/downloads/t20s_json.zip";

async function main() {
  if (!fs.existsSync(DATA_RAW_DIR)) {
    fs.mkdirSync(DATA_RAW_DIR, { recursive: true });
  }

  // 1. Download People Register
  const peoplePath = path.join(DATA_RAW_DIR, "people.csv");
  if (!fs.existsSync(peoplePath)) {
    console.log(`[ETL] Downloading Cricsheet People Register from ${PEOPLE_URL}...`);
    execSync(`curl -sSL "${PEOPLE_URL}" -o "${peoplePath}"`, { stdio: "inherit" });
    console.log(`[ETL] Saved people register to ${peoplePath}`);
  } else {
    console.log(`[ETL] people.csv already exists at ${peoplePath}`);
  }

  // 2. Download T20s match archive
  const t20ZipPath = path.join(DATA_RAW_DIR, "t20s_json.zip");
  const t20ExtractDir = path.join(DATA_RAW_DIR, "t20s_json");

  if (!fs.existsSync(t20ZipPath) && !fs.existsSync(t20ExtractDir)) {
    console.log(`[ETL] Downloading international T20 match archive from ${T20S_URL}...`);
    execSync(`curl -sSL "${T20S_URL}" -o "${t20ZipPath}"`, { stdio: "inherit" });
    console.log(`[ETL] Saved match archive to ${t20ZipPath}`);
  } else {
    console.log(`[ETL] T20 archive or extracted directory already exists.`);
  }

  if (fs.existsSync(t20ZipPath) && !fs.existsSync(t20ExtractDir)) {
    console.log(`[ETL] Extracting ${t20ZipPath} to ${t20ExtractDir}...`);
    fs.mkdirSync(t20ExtractDir, { recursive: true });
    execSync(`unzip -q "${t20ZipPath}" -d "${t20ExtractDir}"`, { stdio: "inherit" });
    console.log(`[ETL] Extraction complete.`);
  }

  console.log("[ETL] Download step finished successfully!");
}

main().catch((err) => {
  console.error("[ETL] Download failed:", err);
  process.exit(1);
});

